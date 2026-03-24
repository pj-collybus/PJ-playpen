/**
 * Risk limits configuration — per-symbol and per-account thresholds.
 *
 * Structure:
 *   default: applies when no symbol-specific or account-specific override exists
 *   symbols: per-symbol overrides (keyed by canonical symbol)
 *   accounts: per-account overrides (keyed by account ID)
 */

'use strict';

module.exports = {
  default: {
    fatFingerPct:           5,        // reject if limit price deviates > 5% from mid
    fatFingerSizeMultiple:  10,       // reject if size > 10x average recent order size
    maxPositionSize:        100,      // max open position in base units per symbol
    maxSingleOrderNotional: 500_000,  // max notional for a single order (USD)
    maxTotalNotional:       2_000_000,// max total open notional across all symbols (USD)
    duplicateWindowMsManual: 2000,    // duplicate detection window for manual orders
    duplicateWindowMsAlgo:   500,     // duplicate detection window for algo orders
    clockSkewMaxMs:         500,      // reject if local clock drifts > 500ms from exchange
  },

  symbols: {
    'BTC-PERP': {
      maxPositionSize:        5,
      maxSingleOrderNotional: 500_000,
      fatFingerPct:           3,       // tighter for BTC
    },
    'ETH-PERP': {
      maxPositionSize:        50,
      maxSingleOrderNotional: 200_000,
      fatFingerPct:           4,
    },
    'SOL-PERP': {
      maxPositionSize:        500,
      maxSingleOrderNotional: 100_000,
      fatFingerPct:           5,
    },
  },

  accounts: {
    // Example: override for a specific account
    // 'account-123': { maxTotalNotional: 1_000_000 }
  },
};
