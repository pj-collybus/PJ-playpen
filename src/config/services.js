/**
 * Service configuration — stub vs real infrastructure switcher.
 *
 * Set environment variables to switch to real infrastructure:
 *   USE_REAL_KAFKA=true
 *   USE_REAL_CLICKHOUSE=true
 *   KAFKA_BROKERS=broker1:9092,broker2:9092
 *   CLICKHOUSE_HOST=http://localhost:8123
 *   CLICKHOUSE_DATABASE=collybus
 */

'use strict';

module.exports = {
  useRealKafka:      process.env.USE_REAL_KAFKA       === 'true',
  useRealClickhouse: process.env.USE_REAL_CLICKHOUSE  === 'true',

  kafka: {
    brokers:  (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    clientId: 'collybus',
  },

  clickhouse: {
    host:     process.env.CLICKHOUSE_HOST     || 'http://localhost:8123',
    database: process.env.CLICKHOUSE_DATABASE || 'collybus',
  },
};
