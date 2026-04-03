namespace Collybus.Api.Models;

public enum OrderSide { Buy, Sell }
public enum OrderType { Market, Limit, Stop, StopLimit }
public enum OrderState { Open, Filled, Cancelled, Rejected, PartiallyFilled }
public enum TimeInForce { Gtc, Ioc, Fok, Gtd, Day }

public record Order
{
    public string OrderId { get; init; } = "";
    public string? VenueOrderId { get; init; }
    public string? ClientOrderId { get; init; }
    public string Exchange { get; init; } = "";
    public string Symbol { get; init; } = "";
    public OrderSide Side { get; init; }
    public OrderType OrderType { get; init; }
    public decimal Quantity { get; init; }
    public decimal FilledQuantity { get; init; }
    public decimal RemainingQuantity { get; init; }
    public decimal? LimitPrice { get; init; }
    public decimal? StopPrice { get; init; }
    public decimal? AvgFillPrice { get; init; }
    public OrderState State { get; init; }
    public TimeInForce TimeInForce { get; init; }
    public string? AlgoType { get; init; }
    public string? ParentOrderId { get; init; }
    public string? StrategyId { get; init; }
    public long CreatedAt { get; init; }
    public long UpdatedAt { get; init; }
    public string? RejectReason { get; init; }
}

public record Fill
{
    public string FillId { get; init; } = "";
    public string OrderId { get; init; } = "";
    public string Exchange { get; init; } = "";
    public string Symbol { get; init; } = "";
    public OrderSide Side { get; init; }
    public decimal FillPrice { get; init; }
    public decimal FillSize { get; init; }
    public long FillTs { get; init; }
    public decimal Commission { get; init; }
    public string CommissionAsset { get; init; } = "";
    public decimal SlippageBps { get; init; }
    public decimal ArrivalMid { get; init; }
}

public record Position
{
    public string Exchange { get; init; } = "";
    public string Symbol { get; init; } = "";
    public string Side { get; init; } = "FLAT";
    public decimal Size { get; init; }
    public string SizeUnit { get; init; } = "";
    public decimal AvgEntryPrice { get; init; }
    public decimal MarkPrice { get; init; }
    public decimal UnrealisedPnl { get; init; }
    public decimal RealisedPnl { get; init; }
    public decimal LiquidationPrice { get; init; }
    public long Timestamp { get; init; }
}

public record Balance
{
    public string Exchange { get; init; } = "";
    public string Currency { get; init; } = "";
    public decimal Available { get; init; }
    public decimal Total { get; init; }
    public decimal UnrealisedPnl { get; init; }
    public long Timestamp { get; init; }
}

public record ExchangeCredentials
{
    public string Exchange { get; init; } = "";
    public Dictionary<string, string> Fields { get; init; } = [];
    public bool Testnet { get; init; }
}
