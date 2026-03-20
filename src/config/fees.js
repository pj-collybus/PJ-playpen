/**
 * Fee schedule — maker/taker rates in basis points per venue.
 *
 * Seeded with current approximate rates (as of 2025).
 * Rates vary by tier/volume — these are base-tier defaults.
 *
 * Usage:
 *   const fees = require('./fees');
 *   const deribitFee = fees.DERIBIT;  // { maker: -1, taker: 5 }
 */

'use strict';

module.exports = {
  DERIBIT: {
    maker:  -1.0,   // -0.01% rebate (perpetuals)
    taker:   5.0,   //  0.05%
  },

  BINANCE: {
    maker:   1.0,   //  0.01%
    taker:   5.0,   //  0.05%
  },

  BYBIT: {
    maker:   1.0,   //  0.01%
    taker:   6.0,   //  0.06%
  },

  OKX: {
    maker:   0.8,   //  0.008%
    taker:   5.0,   //  0.05%
  },

  KRAKEN: {
    maker:   2.0,   //  0.02%
    taker:   5.0,   //  0.05%
  },

  // FX venues (typically per-million, converted to bps equivalent)
  LMAX: {
    maker:   0.2,
    taker:   0.3,
  },

  EBS: {
    maker:   0.1,
    taker:   0.2,
  },

  '360T': {
    maker:   0.3,
    taker:   0.5,
  },
};
