using Collybus.Api.Models;

namespace Collybus.Api.Services;

public interface IOrderService
{
    Task<Order> SubmitAsync(SubmitOrderRequest request, CancellationToken ct = default);
    Task<Order?> GetAsync(string orderId);
    IReadOnlyList<Order> GetAll(string? exchange = null);
}

public record SubmitOrderRequest
{
    public string Exchange { get; init; } = "";
    public string Symbol { get; init; } = "";
    public string Side { get; init; } = "";
    public decimal Quantity { get; init; }
    public decimal? LimitPrice { get; init; }
    public decimal? TriggerPrice { get; init; }
    public string OrderType { get; init; } = "LIMIT";
    public string TimeInForce { get; init; } = "IOC";
    public string AlgoType { get; init; } = "MANUAL";
    public bool? ReduceOnly { get; init; }
    public bool? PostOnly { get; init; }
    public decimal? TickSize { get; init; }
    public string? ParentOrderId { get; init; }
    public string? Label { get; init; }
    public Dictionary<string, string>? Credentials { get; init; }
}

public record CancelOrderRequest
{
    public string OrderId { get; init; } = "";
    public string Exchange { get; init; } = "";
}

public record AmendOrderRequest
{
    public string OrderId { get; init; } = "";
    public string Exchange { get; init; } = "";
    public decimal? Quantity { get; init; }
    public decimal? LimitPrice { get; init; }
}
