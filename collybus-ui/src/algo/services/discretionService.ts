// @ts-nocheck
/**
 * DiscretionService — Portable discretion order logic
 * Ported from monolith src/services/discretionService.js
 *
 * Pure calculation functions — no UI or network dependencies.
 * Wire calculateDiscretionLevels() output to the Sniper strategy (post_snipe + simultaneous).
 */

import { splitWithPassive } from '../utils/sizeUtils';
import type { DiscretionLevel, DiscretionLevelResult, DiscretionCalculateResult, SniperParams } from '../types';

class DiscretionService {
  /** Calculate the discretion ceiling/floor price from bps */
  calculateDiscretionPrice(limitPrice: number, discretionBps: number, side: string): number {
    const direction = side === 'BUY' ? 1 : -1;
    return limitPrice + direction * (limitPrice * discretionBps / 10000);
  }

  /**
   * Calculate the three snipe levels for a discretion order.
   * Returns array of { price, pct, size, levelIndex } for each snipe level.
   * lotSize-aware: sizes round to lot, remainder goes to passive resting.
   */
  calculateDiscretionLevels(
    limitPrice: number,
    discretionBps: number,
    discretionPct: number,
    side: string,
    tickSize: number,
    totalSize: number,
    lotSize: number,
  ): { levels: DiscretionLevelResult[]; passiveSize: number | null; totalSnipeSize: number | null } {
    const discretionPrice = this.calculateDiscretionPrice(limitPrice, discretionBps, side);
    const range = discretionPrice - limitPrice;

    if (totalSize && lotSize) {
      const { activeSizes, passiveSize } = splitWithPassive(totalSize, discretionPct, 3, lotSize);
      const totalActive = activeSizes.reduce((a, b) => a + b, 0);
      const levels: DiscretionLevelResult[] = [
        {
          price: this._roundToTick(limitPrice + range * (1 / 3), tickSize),
          size: activeSizes[0],
          pct: totalSize > 0 ? (activeSizes[0] / totalSize) * 100 : 0,
          levelIndex: 0,
          enabled: true,
        },
        {
          price: this._roundToTick(limitPrice + range * (2 / 3), tickSize),
          size: activeSizes[1],
          pct: totalSize > 0 ? (activeSizes[1] / totalSize) * 100 : 0,
          levelIndex: 1,
          enabled: true,
        },
        {
          price: this._roundToTick(discretionPrice, tickSize),
          size: activeSizes[2],
          pct: totalSize > 0 ? (activeSizes[2] / totalSize) * 100 : 0,
          levelIndex: 2,
          enabled: true,
        },
      ];
      console.log(
        `[discretion] side=${side} limit=${limitPrice} discPrice=${discretionPrice} range=${range} ` +
        `L1=${levels[0].price} L2=${levels[1].price} L3=${levels[2].price} ` +
        `sizes=[${activeSizes}] passive=${passiveSize}`,
      );
      return { levels, passiveSize, totalSnipeSize: totalActive };
    }

    // Fallback: percentage-only (no lotSize rounding)
    const pctPerLevel = Math.round((discretionPct / 3) * 10) / 10;
    const lastPct = Math.round((discretionPct - 2 * pctPerLevel) * 10) / 10;
    return {
      levels: [
        { price: this._roundToTick(limitPrice + range * (1 / 3), tickSize), pct: pctPerLevel, size: 0, levelIndex: 0, enabled: true },
        { price: this._roundToTick(limitPrice + range * (2 / 3), tickSize), pct: pctPerLevel, size: 0, levelIndex: 1, enabled: true },
        { price: this._roundToTick(discretionPrice, tickSize), pct: lastPct, size: 0, levelIndex: 2, enabled: true },
      ],
      passiveSize: null,
      totalSnipeSize: null,
    };
  }

  /** Build the full Sniper strategy params for a discretion order */
  buildSniperParams({
    limitPrice, discretionBps, discretionPct, side, totalSize, symbol, venue, tickSize, lotSize,
  }: {
    limitPrice: number; discretionBps: number; discretionPct: number;
    side: string; totalSize: number; symbol: string; venue?: string;
    tickSize: number; lotSize: number;
  }): { strategyType: string; params: SniperParams } {
    const { levels, passiveSize, totalSnipeSize } = this.calculateDiscretionLevels(
      limitPrice, discretionBps, discretionPct, side, tickSize, totalSize, lotSize,
    );
    const discretionPrice = this.calculateDiscretionPrice(limitPrice, discretionBps, side);
    const postSize = passiveSize ?? (totalSize * (100 - discretionPct)) / 100;
    const snipeSize = totalSnipeSize ?? (totalSize * discretionPct) / 100;

    return {
      strategyType: 'SNIPER',
      params: {
        executionMode: 'post_snipe',
        levelMode: 'simultaneous',
        side: side.toUpperCase() as 'BUY' | 'SELL',
        totalSize,
        symbol,
        venue,
        tickSize: tickSize || 0.0001,
        lotSize: lotSize || 1,
        targetPrice: limitPrice,
        snipeLevel: discretionPrice,
        snipePct: discretionPct,
        minSnipePct: 5,
        levels,
        isDiscretionOrder: true,
      },
    };
  }

  /** Full calculation result for the REST endpoint / preview UI */
  calculate({
    limitPrice, discretionBps, discretionPct, side, tickSize, totalSize, lotSize,
  }: {
    limitPrice: number; discretionBps: number; discretionPct: number;
    side: string; tickSize: number; totalSize?: number | null; lotSize?: number | null;
  }): DiscretionCalculateResult {
    const discretionPrice = this.calculateDiscretionPrice(limitPrice, discretionBps, side);
    const result = this.calculateDiscretionLevels(
      limitPrice, discretionBps, discretionPct, side, tickSize,
      totalSize ?? 0, lotSize ?? 0,
    );
    const postSize = result.passiveSize ?? (totalSize ? (totalSize * (100 - discretionPct)) / 100 : null);
    const snipeSize = result.totalSnipeSize ?? (totalSize ? (totalSize * discretionPct) / 100 : null);

    return {
      discretionPrice,
      discretionBps,
      discretionPct,
      side,
      limitPrice,
      levels: result.levels,
      postSize,
      snipeSize,
    };
  }

  _roundToTick(price: number, tickSize: number): number {
    if (!tickSize || tickSize <= 0) return price;
    return Math.round(price / tickSize) * tickSize;
  }
}

export const discretionService = new DiscretionService();
export { DiscretionService };
