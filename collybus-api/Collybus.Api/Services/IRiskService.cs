using Collybus.Api.Models;

namespace Collybus.Api.Services;

public interface IRiskService
{
    RiskCheckResult Check(RiskCheckRequest request);
    RiskHeadroom GetHeadroom(string symbol, string exchange, string? accountId = null);
}

public record RiskCheckRequest
{
    public string Symbol { get; init; } = "";
    public string Exchange { get; init; } = "";
    public string Side { get; init; } = "";
    public decimal Quantity { get; init; }
    public decimal? LimitPrice { get; init; }
    public string OrderType { get; init; } = "LIMIT";
    public decimal ArrivalMid { get; init; }
    public string AccountId { get; init; } = "default";
}

public record RiskCheckResult
{
    public bool Approved { get; init; }
    public string? RejectReason { get; init; }
    public decimal? NotionalValue { get; init; }
}

public record RiskHeadroom
{
    public decimal PositionHeadroom { get; init; }
    public string PositionUnit { get; init; } = "";
    public decimal MaxPositionSize { get; init; }
    public decimal CurrentPosition { get; init; }
    public decimal NotionalHeadroom { get; init; }
    public decimal MaxTotalNotional { get; init; }
}
