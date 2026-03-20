/**
 * Kafka stub — in-memory EventEmitter matching the KafkaJS producer/consumer API shape exactly.
 *
 * Drop-in replacement for kafkajs.
 * To switch to real Kafka: replace this module with kafkajs and keep the same API.
 *
 * Topic naming convention:
 *   tick.l1.{VENUE}.{SYMBOL}     — L1 BBO
 *   tick.l2.{VENUE}.{SYMBOL}     — L2 book deltas
 *   tick.trades.{VENUE}.{SYMBOL} — trade prints
 *   orders.events.{VENUE}        — order state changes
 *   orders.fills.{VENUE}         — fill events
 *
 * Producer API:
 *   const producer = kafka.producer();
 *   await producer.connect();
 *   await producer.send({ topic: 'tick.l1.DERIBIT.BTC-PERP', messages: [{ value: JSON.stringify(event) }] });
 *   await producer.disconnect();
 *
 * Consumer API:
 *   const consumer = kafka.consumer({ groupId: 'tca-service' });
 *   await consumer.connect();
 *   await consumer.subscribe({ topic: 'tick.l1.DERIBIT.BTC-PERP' });
 *   await consumer.run({ eachMessage: async ({ topic, partition, message }) => {} });
 *   await consumer.disconnect();
 *
 * Buffers the last 1000 messages per topic for late-joining consumers.
 */

'use strict';

const { EventEmitter } = require('events');

const BUFFER_SIZE = 1000;

// Central in-process bus — all producers and consumers share this.
const _bus = new EventEmitter();
_bus.setMaxListeners(200);

/**
 * Per-topic message ring buffer.
 * @type {Map<string, object[]>}
 */
const _topicBuffers = new Map();

function _getBuffer(topic) {
  if (!_topicBuffers.has(topic)) _topicBuffers.set(topic, []);
  return _topicBuffers.get(topic);
}

function _appendToBuffer(topic, message) {
  const buf = _getBuffer(topic);
  buf.push(message);
  if (buf.length > BUFFER_SIZE) {
    buf.splice(0, buf.length - BUFFER_SIZE);
  }
}

class KafkaProducer {
  async connect() {}

  async send({ topic, messages }) {
    for (const msg of messages) {
      const wrapped = {
        key:       msg.key   != null ? Buffer.from(String(msg.key))   : null,
        value:     msg.value != null ? Buffer.from(String(msg.value)) : null,
        timestamp: String(Date.now()),
        headers:   msg.headers || {},
        offset:    String(_getBuffer(topic).length),
      };
      _appendToBuffer(topic, wrapped);
      _bus.emit(topic, {
        topic,
        partition: 0,
        message:   wrapped,
      });
    }
  }

  async sendBatch({ topicMessages }) {
    for (const { topic, messages } of topicMessages) {
      await this.send({ topic, messages });
    }
  }

  async disconnect() {}
}

class KafkaConsumer {
  constructor({ groupId }) {
    this.groupId     = groupId;
    this._subscribed = new Set();
    this._listeners  = [];   // [topic, fn] pairs for cleanup
  }

  async connect() {}

  async subscribe({ topic, fromBeginning = false }) {
    this._subscribed.add(topic);
    this._fromBeginning = fromBeginning;
  }

  async run({ eachMessage }) {
    for (const topic of this._subscribed) {
      // Replay buffered messages if fromBeginning
      if (this._fromBeginning) {
        const buf = _getBuffer(topic);
        for (const message of buf) {
          try {
            await eachMessage({ topic, partition: 0, message });
          } catch (err) {
            console.error(`[kafka-stub] consumer replay error on ${topic}:`, err);
          }
        }
      }

      // Live listener
      const listener = (payload) => {
        Promise.resolve(eachMessage(payload)).catch((err) => {
          console.error(`[kafka-stub] consumer error on ${topic}:`, err);
        });
      };
      _bus.on(topic, listener);
      this._listeners.push([topic, listener]);
    }
  }

  async disconnect() {
    for (const [topic, listener] of this._listeners) {
      _bus.off(topic, listener);
    }
    this._listeners = [];
    this._subscribed.clear();
  }
}

class Kafka {
  constructor({ clientId = 'collybus', brokers = [] } = {}) {
    this.clientId = clientId;
    this.brokers  = brokers;
  }

  producer() {
    return new KafkaProducer();
  }

  consumer({ groupId }) {
    return new KafkaConsumer({ groupId });
  }
}

// ── Topic name helpers ───────────────────────────────────────────────────────

/**
 * Build a topic name following the naming convention.
 * @param {'l1'|'l2'|'trades'|'events'|'fills'} type
 * @param {string} venue
 * @param {string} [symbol] - Required for tick topics, omitted for order topics
 * @returns {string}
 */
function topicName(type, venue, symbol) {
  switch (type) {
    case 'l1':     return `tick.l1.${venue}.${symbol}`;
    case 'l2':     return `tick.l2.${venue}.${symbol}`;
    case 'trades': return `tick.trades.${venue}.${symbol}`;
    case 'events': return `orders.events.${venue}`;
    case 'fills':  return `orders.fills.${venue}`;
    default:       return `${type}.${venue}${symbol ? '.' + symbol : ''}`;
  }
}

/**
 * Parse a topic name back into components.
 * @param {string} topic
 * @returns {{ type: string, venue: string, symbol: string|null }}
 */
function parseTopic(topic) {
  const parts = topic.split('.');
  if (parts[0] === 'tick') {
    return { type: parts[1], venue: parts[2], symbol: parts.slice(3).join('.') || null };
  }
  if (parts[0] === 'orders') {
    return { type: parts[1], venue: parts[2], symbol: null };
  }
  return { type: parts[0], venue: parts[1] || null, symbol: parts.slice(2).join('.') || null };
}

/**
 * Get the buffered messages for a topic.
 * @param {string} topic
 * @returns {object[]}
 */
function getTopicBuffer(topic) {
  return [..._getBuffer(topic)];
}

/** Get all topic names that have buffered messages */
function listTopics() {
  return Array.from(_topicBuffers.keys());
}

module.exports = { Kafka, topicName, parseTopic, getTopicBuffer, listTopics };
