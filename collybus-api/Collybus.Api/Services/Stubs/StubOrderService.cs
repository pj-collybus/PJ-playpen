using Collybus.Api.Models;

namespace Collybus.Api.Services.Stubs;

public class StubOrderService : IOrderService
{
    private readonly Dictionary<string, Order> _orders = [];
    private readonly ILogger<StubOrderService> _logger;

    public StubOrderService(ILogger<StubOrderService> logger)
    {
        _logger = logger;
    }

    public Task<Order> SubmitAsync(SubmitOrderRequest request, CancellationToken ct = default)
    {
        var order = new Order
        {
            OrderId = Guid.NewGuid().ToString(),
            Exchange = request.Exchange,
            Symbol = request.Symbol,
            Side = Enum.Parse<OrderSide>(request.Side, ignoreCase: true),
            OrderType = Enum.Parse<OrderType>(request.OrderType, ignoreCase: true),
            Quantity = request.Quantity,
            FilledQuantity = 0,
            RemainingQuantity = request.Quantity,
            LimitPrice = request.LimitPrice,
            State = OrderState.Open,
            TimeInForce = Enum.Parse<TimeInForce>(request.TimeInForce, ignoreCase: true),
            AlgoType = request.AlgoType,
            CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        _orders[order.OrderId] = order;
        _logger.LogInformation("Order submitted: {OrderId} {Side} {Qty} {Symbol}", order.OrderId, order.Side, order.Quantity, order.Symbol);
        return Task.FromResult(order);
    }

    public Task<Order?> GetAsync(string orderId) =>
        Task.FromResult(_orders.GetValueOrDefault(orderId));

    public IReadOnlyList<Order> GetAll(string? exchange = null) =>
        _orders.Values
            .Where(o => exchange == null || o.Exchange.Equals(exchange, StringComparison.OrdinalIgnoreCase))
            .ToList();
}
