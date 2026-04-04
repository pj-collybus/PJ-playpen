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
public class AlgoStatusReport
{
    // Core identity
    public string StrategyId { get; init; } = "";
    public string StrategyType { get; init; } = "";
    public string Exchange { get; init; } = "";
    public string Symbol { get; init; } = "";
    public string Side { get; init; } = "";
    public AlgoStatus Status { get; init; }

    // Fill accounting
    public decimal TotalSize { get; init; }
    public decimal FilledSize { get; init; }
    public decimal RemainingSize { get; init; }
    public decimal AvgFillPrice { get; init; }
    public decimal ArrivalMid { get; init; }
    public decimal SlippageBps { get; init; }
    public decimal VwapShortfallBps { get; init; }

    // Slicing
    public int CurrentSlice { get; init; }
    public int TotalSlices { get; init; }
    public long? NextSliceAt { get; init; }

    // State
    public string? PauseReason { get; init; }
    public string? ErrorMessage { get; init; }
    public long StartedAt { get; init; }
    public long UpdatedAt { get; init; }
    public string? SummaryLine { get; init; }

    // Fills list
    public List<AlgoFill>? Fills { get; init; }

    // Active order
    public string? Urgency { get; set; }
    public decimal? ActiveOrderPrice { get; set; }
    public decimal? TickSize { get; set; }

    // Chart data (sampled bid/ask/order/fills per tick)
    public List<long>? ChartTimes { get; set; }
    public List<decimal>? ChartBids { get; set; }
    public List<decimal>? ChartAsks { get; set; }
    public List<decimal?>? ChartOrder { get; set; }
    public List<ChartFillPoint>? ChartFills { get; set; }
    public List<decimal>? ChartVwap { get; set; }
    public decimal? ChartTargetPrice { get; set; }
    public decimal? ChartSnipeLevel { get; set; }
    public List<ChartLevelPrice>? ChartLevelPrices { get; set; }

    // SNIPER-specific
    public List<LevelState>? Levels { get; set; }
    public int? ActiveLevelIndex { get; set; }
    public string? ExecutionMode { get; set; }
    public string? LevelMode { get; set; }
    public decimal? RestingOrderSize { get; set; }
    public decimal? SnipedSize { get; set; }
    public decimal? PassiveFillSize { get; set; }
    public string? PostSnipePhase { get; set; }
    public int? RoundNumber { get; set; }
    public decimal? CurrentPostSize { get; set; }
    public decimal? CurrentSnipeSize { get; set; }
    public decimal? SnipePct { get; set; }
    public decimal? SnipeCapRemaining { get; set; }
    public decimal? TargetPrice { get; set; }
    public decimal? SnipeLevel { get; set; }

    // TWAP/VWAP
    public decimal? RollingVwap { get; set; }
    public decimal? DeviationFromVwap { get; set; }
    public bool? InParticipationBand { get; set; }

    // IS
    public decimal? IsCostBps { get; set; }
    public decimal? TimingCostBps { get; set; }
    public decimal? ImpactCostBps { get; set; }
    public decimal? OptimalRate { get; set; }
    public decimal? EstimatedVolatility { get; set; }
    public string? CurrentUrgency { get; set; }

    // POV
    public decimal? ParticipationRate { get; set; }
    public decimal? TargetParticipation { get; set; }
    public decimal? WindowVolume { get; set; }
    public decimal? Deficit { get; set; }

    // ICEBERG
    public decimal? VisibleSize { get; set; }
    public int? DetectionRiskScore { get; set; }
}

public class ChartFillPoint
{
    public long Time { get; init; }
    public decimal Price { get; init; }
    public decimal Size { get; init; }
    public string Side { get; init; } = "";
    public string? FillType { get; init; }
}

public class ChartLevelPrice
{
    public decimal Price { get; init; }
    public string Status { get; init; } = "";
}

public class LevelState
{
    public decimal Price { get; init; }
    public decimal AllocatedSize { get; init; }
    public decimal FilledSize { get; init; }
    public string Status { get; init; } = "";
    public int RetriggerCount { get; init; }
}

// ── TCA ───────────────────────────────────────────────────────────────────
public record TcaResult(
    decimal ArrivalSlippageBps, decimal VwapShortfallBps,
    decimal MarketImpactBps, decimal AllInCostBps
);
