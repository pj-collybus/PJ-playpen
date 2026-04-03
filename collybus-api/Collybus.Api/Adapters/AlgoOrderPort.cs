using Collybus.Algo.Models;
using Collybus.Algo.Ports;
using Collybus.Api.Models;
using Collybus.Api.Services;

namespace Collybus.Api.Adapters;

public class AlgoOrderPort : IOrderPort
{
    private readonly IOrderService _orders;
    private readonly IKeyStore _keys;
    private readonly IEnumerable<IExchangeAdapter> _adapters;

    public AlgoOrderPort(IOrderService orders, IKeyStore keys, IEnumerable<IExchangeAdapter> adapters)
    {
        _orders = orders;
        _keys = keys;
        _adapters = adapters;
    }

    public async Task<string> SubmitAsync(OrderIntent intent)
    {
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
        };

        var order = await _orders.SubmitAsync(request);
        if (order.State == OrderState.Rejected)
            throw new Exception(order.RejectReason ?? "Order rejected");

        return order.OrderId;
    }

    public async Task<bool> CancelAsync(string exchange, string orderId)
    {
        var key = _keys.GetKey(exchange);
        if (key == null) return false;
        var creds = new ExchangeCredentials { Exchange = key.Exchange, Fields = key.Fields, Testnet = key.Testnet };
        var adapter = _adapters.FirstOrDefault(a => a.Venue.Equals(exchange, StringComparison.OrdinalIgnoreCase));
        if (adapter == null) return false;
        var result = await adapter.CancelOrderAsync(orderId, creds);
        return result.Ok;
    }

    public async Task<bool> AmendAsync(string exchange, string orderId, decimal? newQty, decimal? newPrice)
    {
        var key = _keys.GetKey(exchange);
        if (key == null) return false;
        var creds = new ExchangeCredentials { Exchange = key.Exchange, Fields = key.Fields, Testnet = key.Testnet };
        var adapter = _adapters.FirstOrDefault(a => a.Venue.Equals(exchange, StringComparison.OrdinalIgnoreCase));
        if (adapter == null) return false;
        var result = await adapter.AmendOrderAsync(orderId, newQty, newPrice, creds);
        return result.Ok;
    }
}
