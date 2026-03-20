/**
 * Event bus — pub/sub over Kafka (stub or real).
 *
 * Wraps the Kafka producer/consumer API in a simpler interface for internal services.
 * All messages are JSON. Keys are optional routing hints.
 *
 * Topic naming convention:
 *   tick.l1.{VENUE}.{SYMBOL}     — L1 BBO
 *   tick.l2.{VENUE}.{SYMBOL}     — L2 book deltas
 *   tick.trades.{VENUE}.{SYMBOL} — trade prints
 *   orders.events.{VENUE}        — order state changes
 *   orders.fills.{VENUE}         — fill events
 *
 * Legacy generic topics are also kept for backward-compatible subscribers.
 *
 * Usage:
 *   const bus = require('./eventBus');
 *   await bus.publish('tick.l1.DERIBIT.BTC-PERP', bboEvent);
 *   await bus.subscribe('tick.l1.DERIBIT.BTC-PERP', 'mds', async (event) => { ... });
 */

'use strict';

const { Topics } = require('../schemas/events');

// Use stub by default; swap for real kafka via config
let KafkaImpl;
try {
  const { useRealKafka } = require('../config/services');
  if (useRealKafka) {
    KafkaImpl = require('kafkajs').Kafka;
  } else {
    KafkaImpl = require('../stubs/kafka').Kafka;
  }
} catch {
  KafkaImpl = require('../stubs/kafka').Kafka;
}

let topicNameFn;
try {
  topicNameFn = require('../stubs/kafka').topicName;
} catch {
  topicNameFn = null;
}

const kafka = new KafkaImpl({
  clientId: 'collybus',
  brokers:  (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
});

const _producer = kafka.producer();
let   _producerReady = false;

async function _ensureProducer() {
  if (!_producerReady) {
    await _producer.connect();
    _producerReady = true;
  }
}

/**
 * Build the venue/symbol-specific topic name.
 * @param {string} genericTopic - One of Topics.* (e.g. 'market.l1.bbo')
 * @param {object} event        - Event with venue and symbol fields
 * @returns {string} e.g. 'tick.l1.DERIBIT.BTC-PERP'
 */
function buildTopic(genericTopic, event) {
  const venue  = event.venue  || 'UNKNOWN';
  const symbol = event.symbol || 'UNKNOWN';
  switch (genericTopic) {
    case Topics.L1_BBO:       return `tick.l1.${venue}.${symbol}`;
    case Topics.L2_BOOK:      return `tick.l2.${venue}.${symbol}`;
    case Topics.TRADES:       return `tick.trades.${venue}.${symbol}`;
    case Topics.ORDERS:       return `orders.events.${venue}`;
    case Topics.ORDER_EVENTS: return `orders.events.${venue}`;
    case Topics.FILLS:        return `orders.fills.${venue}`;
    default:                  return genericTopic;
  }
}

/**
 * Publish a single event to a topic.
 * Publishes to BOTH the specific topic (tick.l1.DERIBIT.BTC-PERP) and
 * the legacy generic topic (market.l1.bbo) for backward compatibility.
 *
 * @param {string} topic   - One of Topics.* (generic)
 * @param {object} event   - Event payload (will be JSON-serialised)
 * @param {string} [key]   - Optional partition key (e.g. canonical symbol)
 */
async function publish(topic, event, key) {
  await _ensureProducer();

  const specificTopic = buildTopic(topic, event);
  const value = JSON.stringify(event);
  const keyStr = key ? String(key) : null;

  // Publish to specific topic
  await _producer.send({
    topic: specificTopic,
    messages: [{ key: keyStr, value }],
  });

  // Also publish to generic topic for backward-compatible consumers
  if (specificTopic !== topic) {
    await _producer.send({
      topic,
      messages: [{ key: keyStr, value }],
    });
  }
}

/**
 * Subscribe to a topic.
 * @param {string}   topic     - Topic name (specific or generic)
 * @param {string}   groupId   - Consumer group ID (service name)
 * @param {function} handler   - async (event: object) => void
 */
async function subscribe(topic, groupId, handler) {
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const event = JSON.parse(message.value.toString());
        await handler(event);
      } catch (err) {
        console.error(`[eventBus] handler error on ${topic}:`, err);
      }
    },
  });
  return consumer; // caller may call consumer.disconnect() to unsubscribe
}

module.exports = { publish, subscribe, Topics, buildTopic };
