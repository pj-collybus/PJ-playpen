namespace Collybus.Api.Models;

public enum StrategyType { Twap, Vwap, Sniper, Iceberg, Pov, Is }
public enum StrategyStatus { Waiting, Running, Paused, Completed, Stopped, Error }

public record LevelState
{
    public decimal Price { get; init; }
    public decimal Pct { get; init; }
    public decimal AllocatedSize { get; init; }
    public decimal FilledSize { get; init; }
    public string Status { get; init; } = "WAITING";
    public int RetriggerCount { get; init; }
}

public record ChartFill
{
    public long Time { get; init; }
    public decimal Price { get; init; }
    public decimal Size { get; init; }
    public string Side { get; init; } = "";
    public string FillType { get; init; } = "";
    public bool Simulated { get; init; }
}

public record StrategyState
{
    public string StrategyId { get; init; } = "";
    public StrategyType Type { get; init; }
    public StrategyStatus Status { get; init; }
    public string Exchange { get; init; } = "";
    public string Symbol { get; init; } = "";
    public string Side { get; init; } = "";
    public decimal TotalSize { get; init; }
    public decimal FilledQty { get; init; }
    public decimal RemainingQty { get; init; }
    public decimal AvgFillPrice { get; init; }
    public decimal ArrivalPrice { get; init; }
    public decimal SlippageVsArrival { get; init; }
    public decimal SlippageVsVwap { get; init; }
    public long StartTime { get; init; }
    public long Elapsed { get; init; }
    public long? TimeRemaining { get; init; }
    public string SummaryLine { get; init; } = "";
    public List<long> ChartTimes { get; init; } = [];
    public List<decimal> ChartBids { get; init; } = [];
    public List<decimal> ChartAsks { get; init; } = [];
    public List<ChartFill> ChartFills { get; init; } = [];
    public List<LevelState> Levels { get; init; } = [];
    public decimal? ChartTargetPrice { get; init; }
    public decimal? ChartSnipeLevel { get; init; }
    public string? ExecutionMode { get; init; }
    public string? LevelMode { get; init; }
    public decimal? TickSize { get; init; }
}

public record StartStrategyRequest
{
    public string StrategyType { get; init; } = "";
    public Dictionary<string, object> Params { get; init; } = [];
}

public record StrategyActionResponse
{
    public bool Ok { get; init; }
    public string? StrategyId { get; init; }
    public string? Error { get; init; }
}
