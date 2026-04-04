using System.Collections.Concurrent;
using Collybus.Algo.Models;
using Collybus.Algo.Ports;
using Collybus.Api.Models;
using Collybus.Api.Services;

namespace Collybus.Api.Adapters;

/// <summary>
/// Bridges algo engine's IOrderPort to exchange adapters.
/// Maintains VenueOrderId → (ClientOrderId, StrategyId) mapping
/// so fills from exchanges can be routed back to the correct strategy.
/// </summary>
public class AlgoOrderPort : IOrderPort
{
    private readonly IOrderService _orders;
    private readonly IKeyStore _keys;
    private readonly IEnumerable<IExchangeAdapter> _adapters;

    // VenueOrderId → (ClientOrderId, StrategyId) for fill routing
    private readonly ConcurrentDictionary<string, (string ClientOrderId, string StrategyId)> _orderMap = new();

    public AlgoOrderPort(IOrderService orders, IKeyStore keys, IEnumerable<IExchangeAdapter> adapters)
    {
        _orders = orders; _keys = keys; _adapters = adapters;
    }

    /// <summary>Try to resolve a venue order ID to (clientOrderId, strategyId).</summary>
    public (string ClientOrderId, string StrategyId)? ResolveVenueOrderId(string venueOrderId)
        => _orderMap.TryGetValue(venueOrderId, out var entry) ? entry : null;

    public async Task<string> SubmitAsync(OrderIntent intent)
    {
        // Pre-register mapping by label (= algo's ClientOrderId) BEFORE submitting
        // to avoid race condition where websocket fill arrives before RPC response
        _orderMap[intent.ClientOrderId] = (intent.ClientOrderId, intent.StrategyId);

        var request = new SubmitOrderRequest
        {
            Exchange = intent.Exchange,
            Symbol = intent.Symbol,
            Side = intent.Side,
            Quantity = intent.Quantity,
            LimitPrice = intent.LimitPrice,
            TriggerPrice = intent.TriggerPrice,
            OrderType = intent.OrderType,
            TimeInForce = intent.TimeInForce,
            PostOnly = intent.PostOnly,
            ReduceOnly = intent.ReduceOnly,
            AlgoType = intent.Tag ?? "ALGO",
            Label = intent.ClientOrderId,  // Pass algo's client ID as exchange label
        };

        var order = await _orders.SubmitAsync(request);
        if (order.State == OrderState.Rejected)
            throw new Exception(order.RejectReason ?? "Order rejected");

        // Map venue order ID back to client order ID + strategy ID
        var venueId = order.VenueOrderId ?? order.OrderId;
        _orderMap[venueId] = (intent.ClientOrderId, intent.StrategyId);

        // Also map by OrderId in case they differ
        if (order.OrderId != venueId)
            _orderMap[order.OrderId] = (intent.ClientOrderId, intent.StrategyId);

        return intent.ClientOrderId; // Return OUR client ID, not venue ID
    }

    public async Task<bool> CancelAsync(string exchange, string orderId)
    {
        // Try to resolve to venue ID for the exchange
        var key = _keys.GetKey(exchange);
        if (key == null) return false;
        var creds = new ExchangeCredentials { Exchange = key.Exchange, Fields = key.Fields, Testnet = key.Testnet };
        var adapter = _adapters.FirstOrDefault(a => a.Venue.Equals(exchange, StringComparison.OrdinalIgnoreCase));
        if (adapter == null) return false;

        // The orderId here is our ClientOrderId — we need the venue ID
        // Search the map for matching client ID
        var venueId = orderId;
        foreach (var (vid, (cid, _)) in _orderMap)
        {
            if (cid == orderId) { venueId = vid; break; }
        }

        var result = await adapter.CancelOrderAsync(venueId, creds);
        return result.Ok;
    }

    public async Task<bool> AmendAsync(string exchange, string orderId, decimal? newQty, decimal? newPrice)
    {
        var key = _keys.GetKey(exchange);
        if (key == null) return false;
        var creds = new ExchangeCredentials { Exchange = key.Exchange, Fields = key.Fields, Testnet = key.Testnet };
        var adapter = _adapters.FirstOrDefault(a => a.Venue.Equals(exchange, StringComparison.OrdinalIgnoreCase));
        if (adapter == null) return false;

        var venueId = orderId;
        foreach (var (vid, (cid, _)) in _orderMap)
        {
            if (cid == orderId) { venueId = vid; break; }
        }

        var result = await adapter.AmendOrderAsync(venueId, newQty, newPrice, creds);
        return result.Ok;
    }
}
