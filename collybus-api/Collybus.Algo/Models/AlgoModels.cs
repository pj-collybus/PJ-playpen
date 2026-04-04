namespace Collybus.Algo.Models;

// ── State machine ──────────────────────────────────────────────────────────
public enum AlgoStatus
{
    Waiting, Running, Pausing, Paused, Completing, Completed, Stopped, Error
}

// ── Market data ────────────────────────────────────────────────────────────
public record MarketDataPoint(
    string Symbol, string Exchange,
    decimal Bid, decimal Ask, decimal Mid, decimal SpreadBps,
    decimal LastTrade, decimal LastTradeSize, long Timestamp
);

// ── Fill ──────────────────────────────────────────────────────────────────
public record AlgoFill(
    string StrategyId, string ClientOrderId, string ExchangeOrderId,
    decimal FillPrice, decimal FillSize, decimal Commission, long Timestamp
);

// ── Order intent ──────────────────────────────────────────────────────────
public record OrderIntent(
    string StrategyId, string ClientOrderId,
    string Exchange, string Symbol, string Side, string OrderType,
    decimal Quantity, decimal? LimitPrice, decimal? TriggerPrice,
    string TimeInForce,
    bool PostOnly = false, bool ReduceOnly = false, string? Tag = null
);

// ── Strategy parameters ────────────────────────────────────────────────────
public record AlgoParams(
    string StrategyType, string Exchange, string Symbol, string Side,
    decimal TotalSize, decimal TickSize, decimal LotSize,
    decimal ArrivalMid, decimal ArrivalBid, decimal ArrivalAsk,
    int? DurationMinutes = null,
    string? StartMode = "immediate",
    string? StartTime = null,
    decimal? TriggerPrice = null,
    string? TriggerDirection = null,
    string? Urgency = "balanced",
    int? NumSlices = null,
    decimal? LimitPrice = null,
    string? LimitMode = "none",
    string? VwapMode = "realtime",
    int? VwapWindowSeconds = 300,
    decimal? ParticipationBandBps = 20,
    decimal? MaxDeviationBps = 50,
    string? SniperMode = "snipe",
    string? LevelMode = "sequential",
    List<SniperLevel>? Levels = null,
    decimal? MinVolume = null,
    decimal? MomentumBps = null,
    string? RetriggerMode = "same",
    int? RetriggerTicks = null,
    bool IcebergSnipe = false,
    decimal? SniperSlicePct = null,
    decimal? PostPrice = null,
    decimal? SnipeCeiling = null,
    decimal? SnipeCap = null,
    decimal? VisibleSize = null,
    decimal? VisibleVariancePct = null,
    int? RefreshDelayMs = null,
    decimal? ParticipationPct = null,
    int? VolumeWindowSeconds = null,
    decimal? MinChildSize = null,
    decimal? MaxChildSize = null,
    decimal? MaxSpreadBps = 50,
    decimal? ScheduleVariancePct = 10,
    decimal? RiskAversion = null,
    int? VolatilityLookbackMinutes = null,
    decimal? MarketImpactCoeff = null,
    string? UrgencyBias = null
);

public record SniperLevel(int Index, decimal Price, decimal AllocationPct, bool Enabled = true);

// ── Strategy status output ─────────────────────────────────────────────────
public record AlgoStatusReport(
    string StrategyId, string StrategyType,
    string Exchange, string Symbol, string Side,
    AlgoStatus Status,
    decimal TotalSize, decimal FilledSize, decimal RemainingSize,
    decimal AvgFillPrice, decimal ArrivalMid,
    decimal SlippageBps, decimal VwapShortfallBps,
    int CurrentSlice, int TotalSlices,
    long? NextSliceAt, string? PauseReason, string? ErrorMessage,
    long StartedAt, long UpdatedAt,
    string? SummaryLine = null,
    List<AlgoFill>? Fills = null
);

// ── TCA ───────────────────────────────────────────────────────────────────
public record TcaResult(
    decimal ArrivalSlippageBps, decimal VwapShortfallBps,
    decimal MarketImpactBps, decimal AllInCostBps
);
