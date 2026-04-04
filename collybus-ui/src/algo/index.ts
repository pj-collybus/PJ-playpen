/**
 * Algo module — barrel export & strategy registry
 *
 * All 6 strategies: SNIPER, TWAP, VWAP, IS, POV, ICEBERG.
 * Fully refactored with BaseStrategy, ChartCollector, shared utils.
 *
 * Future SOR integration points:
 *   - extend MarketData with bids/asks depth arrays
 *   - extend StrategyContext with emitEvent() for routing hints
 *   - strategies already emit structured getState() snapshots for monitoring
 */

export * from './types';
export * from './utils/sizeUtils';
export * from './utils/timeUtils';
export * from './utils/chartCollector';
export * from './services/discretionService';
export * from './strategies/baseStrategy';

export { config as SniperConfig,   SniperStrategy,   estimateDuration as sniperEstimateDuration   } from './strategies/sniper';
export { config as TwapConfig,     TWAPStrategy,     estimateDuration as twapEstimateDuration     } from './strategies/twap';
export { config as VwapConfig,     VWAPStrategy,     estimateDuration as vwapEstimateDuration     } from './strategies/vwap';
export { config as IsConfig,       ISStrategy,       estimateDuration as isEstimateDuration       } from './strategies/is';
export { config as PovConfig,      POVStrategy,      estimateDuration as povEstimateDuration      } from './strategies/pov';
export { config as IcebergConfig,  IcebergStrategy,  estimateDuration as icebergEstimateDuration  } from './strategies/iceberg';

// ── Strategy registry ─────────────────────────────────────────────────────────

import { config as sniperConfig,  SniperStrategy  } from './strategies/sniper';
import { config as twapConfig,    TWAPStrategy    } from './strategies/twap';
import { config as vwapConfig,    VWAPStrategy    } from './strategies/vwap';
import { config as isConfig,      ISStrategy      } from './strategies/is';
import { config as povConfig,     POVStrategy     } from './strategies/pov';
import { config as icebergConfig, IcebergStrategy } from './strategies/iceberg';
import type { StrategyConfig, IStrategy } from './types';

type AnyParams = Record<string, unknown>;
interface StrategyPlugin { config: StrategyConfig; Strategy: new (p: AnyParams) => IStrategy; }

const _registry = new Map<string, StrategyPlugin>();
const _register = (p: StrategyPlugin) => _registry.set(p.config.name.toUpperCase(), p);

_register({ config: sniperConfig,  Strategy: SniperStrategy  as unknown as new (p: AnyParams) => IStrategy });
_register({ config: twapConfig,    Strategy: TWAPStrategy    as unknown as new (p: AnyParams) => IStrategy });
_register({ config: vwapConfig,    Strategy: VWAPStrategy    as unknown as new (p: AnyParams) => IStrategy });
_register({ config: isConfig,      Strategy: ISStrategy      as unknown as new (p: AnyParams) => IStrategy });
_register({ config: povConfig,     Strategy: POVStrategy     as unknown as new (p: AnyParams) => IStrategy });
_register({ config: icebergConfig, Strategy: IcebergStrategy as unknown as new (p: AnyParams) => IStrategy });

export const getStrategyPlugin   = (name: string) => _registry.get(name.toUpperCase());
export const listStrategyConfigs = (): StrategyConfig[] => Array.from(_registry.values()).map(p => p.config);

export function createStrategy(strategyType: string, params: AnyParams): IStrategy {
  const plugin = getStrategyPlugin(strategyType);
  if (!plugin) throw new Error(`Unknown strategy type: ${strategyType}. Available: ${Array.from(_registry.keys()).join(', ')}`);
  return new plugin.Strategy(params);
}
