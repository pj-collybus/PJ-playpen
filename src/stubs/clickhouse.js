/**
 * ClickHouse stub — in-memory ring buffer matching the @clickhouse/client API shape exactly.
 *
 * Drop-in replacement for @clickhouse/client.
 * To switch to real ClickHouse: replace this module and keep the same API.
 *
 * API:
 *   const client = createClient({ host, database });
 *   await client.insert({ table: 'market_l1_bbo', values: [row], format: 'JSONEachRow' });
 *   const result = await client.query({ query: 'SELECT...', format: 'JSONEachRow' });
 *   const rows = await result.json();
 *
 * Keeps the last 10,000 rows per table. Logs a warning when a table hits capacity.
 *
 * Supported query patterns (used by TCA service):
 *   - SELECT * FROM <table>
 *   - SELECT * FROM <table> WHERE <col> = '<value>'
 *   - SELECT * FROM <table> WHERE <col> = '<value>' AND <col2> = '<value2>'
 *   - SELECT * FROM <table> WHERE <col> >= <number> AND <col2> <= <number>
 *   - SELECT * FROM <table> WHERE <col> = '<value>' AND <ts> >= <n> AND <ts> <= <n>
 *   - Any of the above with ORDER BY <col> DESC/ASC and LIMIT <n>
 */

'use strict';

const DEFAULT_RING_SIZE = 10_000;

/** Track which tables have already logged a full warning */
const _warnedTables = new Set();

class ResultSet {
  constructor(rows) {
    this._rows = rows;
  }
  async json() {
    return this._rows;
  }
  async text() {
    return JSON.stringify(this._rows);
  }
}

class ClickHouseStub {
  /**
   * @param {object} opts
   * @param {number} [opts.ringSize=10000] - Max rows to retain per table
   */
  constructor({ host = 'localhost', database = 'collybus', ringSize = DEFAULT_RING_SIZE } = {}) {
    this.host     = host;
    this.database = database;
    this.ringSize = ringSize;
    /** @type {Map<string, object[]>} table name → ring buffer */
    this._tables  = new Map();
  }

  _getTable(name) {
    if (!this._tables.has(name)) this._tables.set(name, []);
    return this._tables.get(name);
  }

  /**
   * Insert rows into a table.
   * @param {object} opts
   * @param {string}   opts.table
   * @param {object[]} opts.values
   * @param {string}   [opts.format] - accepted for API compatibility ('JSONEachRow')
   */
  async insert({ table, values, format }) {
    const buf = this._getTable(table);
    for (const row of values) {
      buf.push(row);
    }
    // Trim to ring size and warn
    if (buf.length > this.ringSize) {
      if (!_warnedTables.has(table)) {
        console.warn(`[clickhouse-stub] Table "${table}" reached ${this.ringSize} row limit — oldest rows are being evicted.`);
        _warnedTables.add(table);
      }
      buf.splice(0, buf.length - this.ringSize);
    }
  }

  /**
   * Execute a query with full WHERE clause support.
   *
   * Handles:
   *   - Multiple AND conditions
   *   - String equality: col = 'value'
   *   - Numeric equality: col = number
   *   - Range operators: col >= number, col <= number, col > number, col < number
   *   - ORDER BY col DESC/ASC
   *   - LIMIT n
   *
   * @param {object} opts
   * @param {string} opts.query
   * @param {string} [opts.format] - accepted for API compatibility
   * @returns {Promise<ResultSet>}
   */
  async query({ query, format }) {
    const q     = query.trim().replace(/\s+/g, ' ');
    const table = this._parseTable(q);
    let   rows  = table ? [...this._getTable(table)] : [];

    // Parse all WHERE conditions
    const conditions = this._parseWhere(q);
    if (conditions.length > 0) {
      rows = rows.filter(row => {
        for (const cond of conditions) {
          const val = row[cond.col];
          switch (cond.op) {
            case '=':
              if (cond.isString) { if (String(val) !== cond.value) return false; }
              else               { if (Number(val) !== cond.numValue) return false; }
              break;
            case '>=':
              if (Number(val) < cond.numValue) return false;
              break;
            case '<=':
              if (Number(val) > cond.numValue) return false;
              break;
            case '>':
              if (Number(val) <= cond.numValue) return false;
              break;
            case '<':
              if (Number(val) >= cond.numValue) return false;
              break;
            case '!=':
              if (cond.isString) { if (String(val) === cond.value) return false; }
              else               { if (Number(val) === cond.numValue) return false; }
              break;
          }
        }
        return true;
      });
    }

    // ORDER BY col DESC / ASC
    const orderMatch = q.match(/ORDER BY\s+(\w+)\s*(DESC|ASC)?/i);
    if (orderMatch) {
      const [, col, dir] = orderMatch;
      const desc = (dir || 'ASC').toUpperCase() === 'DESC';
      rows.sort((a, b) => {
        if (a[col] < b[col]) return desc ? 1 : -1;
        if (a[col] > b[col]) return desc ? -1 : 1;
        return 0;
      });
    }

    // LIMIT n
    const limitMatch = q.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1], 10));
    }

    return new ResultSet(rows);
  }

  /**
   * Parse WHERE clause into an array of conditions.
   * @param {string} q - normalised query string
   * @returns {{ col: string, op: string, value: string, numValue: number, isString: boolean }[]}
   */
  _parseWhere(q) {
    const whereIdx = q.toUpperCase().indexOf('WHERE ');
    if (whereIdx === -1) return [];

    // Extract everything after WHERE until ORDER BY or LIMIT or end
    let whereClause = q.slice(whereIdx + 6);
    const endIdx = whereClause.search(/\b(ORDER|LIMIT|GROUP|HAVING)\b/i);
    if (endIdx !== -1) whereClause = whereClause.slice(0, endIdx);

    const conditions = [];
    // Split on AND (case-insensitive)
    const parts = whereClause.split(/\bAND\b/i);

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Match: col op 'string_value' or col op number
      const m = trimmed.match(/^(\w+)\s*(>=|<=|!=|>|<|=)\s*(?:'([^']*)'|([\d.e+-]+))$/i);
      if (m) {
        const [, col, op, strVal, numVal] = m;
        conditions.push({
          col,
          op,
          value:    strVal ?? numVal,
          numValue: parseFloat(numVal ?? strVal),
          isString: strVal !== undefined,
        });
      }
    }

    return conditions;
  }

  _parseTable(q) {
    const m = q.match(/FROM\s+(\w+)/i);
    return m ? m[1] : null;
  }

  /**
   * Return all rows for a table (no SQL parsing).
   * @param {string} table
   * @returns {object[]}
   */
  scan(table) {
    return [...this._getTable(table)];
  }

  /** Number of rows stored in a table */
  count(table) {
    return this._getTable(table).length;
  }

  /** Drop all rows from a table */
  truncate(table) {
    this._tables.set(table, []);
    _warnedTables.delete(table);
  }

  /** List all table names */
  listTables() {
    return Array.from(this._tables.keys());
  }
}

function createClient(opts = {}) {
  return new ClickHouseStub(opts);
}

module.exports = { createClient, ClickHouseStub };
