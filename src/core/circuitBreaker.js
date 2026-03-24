/**
 * Circuit breaker — protects outbound calls from cascading failures.
 *
 * States:
 *   CLOSED    — requests flow through normally
 *   OPEN      — requests blocked immediately (CircuitOpenError)
 *   HALF_OPEN — one test request allowed; success → CLOSED, failure → OPEN
 *
 * Usage:
 *   const { CircuitBreaker } = require('./circuitBreaker');
 *   const breaker = new CircuitBreaker('DERIBIT_rest_orders', { failureThreshold: 5 });
 *   const result = await breaker.execute(() => fetch(...));
 */

'use strict';

const { publish } = require('./eventBus');

const STATE = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

class CircuitOpenError extends Error {
  constructor(name) {
    super(`Circuit breaker ${name} is OPEN — request blocked`);
    this.name       = 'CircuitOpenError';
    this.breakerName = name;
  }
}

class CircuitBreaker {
  /**
   * @param {string} name - Unique identifier e.g. 'DERIBIT_rest_orders'
   * @param {object} [opts]
   * @param {number} [opts.failureThreshold=5]
   * @param {number} [opts.recoveryTimeout=30000]
   * @param {number} [opts.successThreshold=2]
   * @param {string} [opts.exchange] - Exchange name for event metadata
   */
  constructor(name, { failureThreshold = 5, recoveryTimeout = 30_000, successThreshold = 2, exchange = '' } = {}) {
    this.name             = name;
    this.exchange         = exchange || name.split('_')[0];
    this._failureThreshold = failureThreshold;
    this._recoveryTimeout  = recoveryTimeout;
    this._successThreshold = successThreshold;

    this._state            = STATE.CLOSED;
    this._failures         = 0;
    this._successes        = 0;
    this._lastFailure      = null;
    this._lastSuccess      = null;
    this._openedAt         = null;
    this._halfOpenTimer    = null;
  }

  /**
   * Execute an async function through the circuit breaker.
   * @param {function} fn - async () => result
   * @returns {Promise<*>}
   * @throws {CircuitOpenError} if circuit is OPEN
   */
  async execute(fn) {
    if (this._state === STATE.OPEN) {
      // Check if recovery timeout elapsed → move to HALF_OPEN
      if (Date.now() - this._openedAt >= this._recoveryTimeout) {
        this._transitionTo(STATE.HALF_OPEN);
      } else {
        throw new CircuitOpenError(this.name);
      }
    }

    if (this._state === STATE.HALF_OPEN) {
      // Allow one test request
      try {
        const result = await fn();
        this._onSuccess();
        return result;
      } catch (err) {
        this._onFailure();
        throw err;
      }
    }

    // CLOSED — normal flow
    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  /**
   * Get current breaker status.
   * @returns {{ state: string, failures: number, lastFailure: number|null, lastSuccess: number|null }}
   */
  getStatus() {
    return {
      state:       this._state,
      failures:    this._failures,
      lastFailure: this._lastFailure,
      lastSuccess: this._lastSuccess,
    };
  }

  /**
   * Manually reset the breaker to CLOSED.
   */
  reset() {
    this._transitionTo(STATE.CLOSED);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _onSuccess() {
    this._lastSuccess = Date.now();

    if (this._state === STATE.HALF_OPEN) {
      this._successes++;
      if (this._successes >= this._successThreshold) {
        this._transitionTo(STATE.CLOSED);
      }
    } else {
      // CLOSED — reset failure count on any success
      this._failures  = 0;
      this._successes = 0;
    }
  }

  _onFailure() {
    this._lastFailure = Date.now();
    this._failures++;

    if (this._state === STATE.HALF_OPEN) {
      // Single failure in HALF_OPEN → back to OPEN
      this._transitionTo(STATE.OPEN);
    } else if (this._state === STATE.CLOSED && this._failures >= this._failureThreshold) {
      this._transitionTo(STATE.OPEN);
    }
  }

  _transitionTo(newState) {
    const prevState = this._state;
    if (prevState === newState) return;

    this._state = newState;

    if (newState === STATE.OPEN) {
      this._openedAt  = Date.now();
      this._successes = 0;
      console.warn(`Circuit breaker for ${this.name} opened after ${this._failures} failures`);
    } else if (newState === STATE.HALF_OPEN) {
      this._successes = 0;
      console.log(`Circuit breaker for ${this.name} entering half-open`);
    } else if (newState === STATE.CLOSED) {
      this._failures  = 0;
      this._successes = 0;
      this._openedAt  = null;
      console.log(`Circuit breaker for ${this.name} closed — service recovered`);
    }

    // Publish state change to event bus
    const event = {
      type:     'circuit_breaker',
      name:     this.name,
      state:    newState,
      exchange: this.exchange,
      prevState,
      ts:       Date.now(),
    };
    publish('system.circuit_breaker', event, this.name).catch(() => {});
  }
}

module.exports = { CircuitBreaker, CircuitOpenError, STATE };
