using Collybus.Api.Adapters;
using Collybus.Api.Hubs;
using Collybus.Api.Models;
using Microsoft.AspNetCore.SignalR;

namespace Collybus.Api.Services;

public class RealOrderService : IOrderService
{
    private readonly IKeyStore _keys;
    private readonly IEnumerable<IExchangeAdapter> _adapters;
    private readonly IHubContext<CollybusHub> _hub;
    private readonly ILogger<RealOrderService> _logger;
    private readonly Dictionary<string, Order> _orders = [];

    public RealOrderService(
        IKeyStore keys,
        IEnumerable<IExchangeAdapter> adapters,
        IHubContext<CollybusHub> hub,
        ILogger<RealOrderService> logger)
    {
        _keys = keys;
        _adapters = adapters;
        _hub = hub;
        _logger = logger;
    }

    public async Task<Order> SubmitAsync(SubmitOrderRequest request, CancellationToken ct = default)
    {
        var exchange = request.Exchange?.ToUpperInvariant() ?? "";

        var adapter = _adapters.FirstOrDefault(a =>
            a.Venue.Equals(exchange, StringComparison.OrdinalIgnoreCase));

        var key = _keys.GetKey(exchange);
        if (adapter == null || key == null)
        {
            _logger.LogWarning("[Order] No adapter or key for {Exchange}", exchange);
            return CreateLocalOrder(request, exchange);
        }

        var creds = new ExchangeCredentials
        {
            Exchange = key.Exchange,
            Fields = key.Fields,
            Testnet = key.Testnet,
        };

        _logger.LogInformation("[Order] Submit {Side} {Qty} {Symbol} @ {Price} on {Exchange}",
            request.Side, request.Quantity, request.Symbol, request.LimitPrice, exchange);

        try
        {
            var result = await adapter.SubmitOrderAsync(request, creds);

            var order = new Order
            {
                OrderId = result.VenueOrderId ?? Guid.NewGuid().ToString(),
                VenueOrderId = result.VenueOrderId,
                Exchange = exchange,
                Symbol = request.Symbol,
                Side = Enum.Parse<OrderSide>(request.Side, ignoreCase: true),
                OrderType = Enum.Parse<OrderType>(request.OrderType, ignoreCase: true),
                Quantity = request.Quantity,
                FilledQuantity = result.FilledQty,
                RemainingQuantity = request.Quantity - result.FilledQty,
                LimitPrice = request.LimitPrice,
                AvgFillPrice = result.AvgFillPrice > 0 ? result.AvgFillPrice : null,
                State = result.FilledQty >= request.Quantity ? OrderState.Filled
                    : result.FilledQty > 0 ? OrderState.PartiallyFilled
                    : result.Ok ? OrderState.Open : OrderState.Rejected,
                TimeInForce = Enum.Parse<TimeInForce>(request.TimeInForce, ignoreCase: true),
                AlgoType = request.AlgoType,
                RejectReason = result.RejectReason,
                CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };

            _orders[order.OrderId] = order;
            _ = _hub.Clients.All.SendAsync("OrderUpdate", order, ct);
            return order;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Order] Submit failed for {Symbol} on {Exchange}", request.Symbol, exchange);
            var rejected = CreateLocalOrder(request, exchange);
            rejected = rejected with { State = OrderState.Rejected, RejectReason = ex.Message };
            _orders[rejected.OrderId] = rejected;
            _ = _hub.Clients.All.SendAsync("OrderUpdate", rejected, ct);
            return rejected;
        }
    }

    public Task<Order?> GetAsync(string orderId) =>
        Task.FromResult(_orders.GetValueOrDefault(orderId));

    public IReadOnlyList<Order> GetAll(string? exchange = null) =>
        _orders.Values
            .Where(o => exchange == null || o.Exchange.Equals(exchange, StringComparison.OrdinalIgnoreCase))
            .ToList();

    private Order CreateLocalOrder(SubmitOrderRequest request, string exchange) => new()
    {
        OrderId = Guid.NewGuid().ToString(),
        Exchange = exchange,
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
}
