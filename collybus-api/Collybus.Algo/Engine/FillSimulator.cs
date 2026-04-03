using Collybus.Algo.Models;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Engine;

/// <summary>
/// Simulates fills for testnet venues where the matching engine is unreliable.
/// BUY fills when ask <= limit, SELL fills when bid >= limit.
/// Random latency 500-2000ms after cross. Translated from monolith engine.js.
/// </summary>
public class FillSimulator
{
    private readonly HashSet<string> _simVenues = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, PendingSimFill> _pending = new();
    private readonly Dictionary<string, MarketDataPoint> _lastMd = new();
    private readonly Dictionary<string, long> _lastSynthTrade = new();
    private readonly ILogger _log;
    private readonly Random _rng = new();

    public event Func<AlgoFill, Task>? OnFill;
    public event Func<string, MarketDataPoint, Task>? OnSyntheticTrade;

    public FillSimulator(ILogger log, IEnumerable<string> simVenues)
    {
        _log = log;
        foreach (var v in simVenues) _simVenues.Add(v);
    }

    public bool IsSimVenue(string exchange) => _simVenues.Contains(exchange);

    public void RegisterOrder(OrderIntent intent)
    {
        if (!IsSimVenue(intent.Exchange)) return;

        if (intent.TimeInForce is "IOC" or "FOK")
        {
            // Immediate fill at current market
            _ = Task.Delay(_rng.Next(100, 500)).ContinueWith(async _ =>
            {
                var md = _lastMd.GetValueOrDefault($"{intent.Exchange}:{intent.Symbol}");
                if (md == null) return;
                var px = intent.Side.ToUpper() == "BUY" ? md.Ask : md.Bid;
                if (px <= 0) px = md.Mid;
                await EmitFill(intent.ClientOrderId, intent.StrategyId, intent.Quantity, px);
            });
            return;
        }

        _pending[intent.ClientOrderId] = new PendingSimFill(
            intent.ClientOrderId, intent.StrategyId,
            intent.Exchange, intent.Symbol, intent.Side,
            intent.Quantity, intent.LimitPrice ?? 0,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), null);
    }

    public void CancelOrder(string clientOrderId) => _pending.Remove(clientOrderId);

    public void OnMarketData(MarketDataPoint data)
        => _lastMd[$"{data.Exchange}:{data.Symbol}"] = data;

    public async Task TickAsync()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var toFill = new List<PendingSimFill>();

        foreach (var (id, fill) in _pending.ToArray())
        {
            var md = _lastMd.GetValueOrDefault($"{fill.Exchange}:{fill.Symbol}");
            if (md == null) continue;

            var crossed = fill.Side.ToUpper() == "BUY"
                ? md.Ask > 0 && md.Ask <= fill.LimitPrice
                : md.Bid > 0 && md.Bid >= fill.LimitPrice;

            if (crossed && fill.CrossedAt == null)
            {
                _pending[id] = fill with { CrossedAt = now };
            }
            else if (fill.CrossedAt.HasValue && now - fill.CrossedAt.Value >= _rng.Next(500, 2001))
            {
                toFill.Add(fill);
            }
        }

        foreach (var fill in toFill)
        {
            _pending.Remove(fill.ClientOrderId);
            var md = _lastMd.GetValueOrDefault($"{fill.Exchange}:{fill.Symbol}");
            var px = fill.Side.ToUpper() == "BUY" ? (md?.Ask ?? fill.LimitPrice) : (md?.Bid ?? fill.LimitPrice);
            await EmitFill(fill.ClientOrderId, fill.StrategyId, fill.Quantity, px);
        }

        // Synthetic trades for POV
        if (OnSyntheticTrade != null)
        {
            foreach (var (key, md) in _lastMd)
            {
                if (!IsSimVenue(md.Exchange) || md.Mid <= 0) continue;
                var last = _lastSynthTrade.GetValueOrDefault(key);
                if (now - last < _rng.Next(2000, 5001)) continue;
                _lastSynthTrade[key] = now;
                var tradePrice = md.Mid * (1 + ((decimal)_rng.NextDouble() - 0.5m) * 0.001m);
                await OnSyntheticTrade(key, md with { LastTrade = tradePrice, LastTradeSize = _rng.Next(1, 21) });
            }
        }
    }

    private async Task EmitFill(string clientOrderId, string strategyId, decimal qty, decimal fillPrice)
    {
        if (OnFill == null) return;
        _log.LogInformation("[FillSim] {Sid} fill: {Qty} @ {Price}", strategyId, qty, fillPrice);
        await OnFill(new AlgoFill(strategyId, clientOrderId, $"SIM-{Guid.NewGuid():N}"[..16],
            fillPrice, qty, qty * fillPrice * 0.0003m, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
    }
}

public record PendingSimFill(
    string ClientOrderId, string StrategyId, string Exchange, string Symbol,
    string Side, decimal Quantity, decimal LimitPrice, long PlacedAt, long? CrossedAt);

/// <summary>Wraps IOrderPort to intercept orders for fill simulation.</summary>
public class SimInterceptOrderPort : Ports.IOrderPort
{
    private readonly Ports.IOrderPort _inner;
    private readonly FillSimulator _sim;

    public SimInterceptOrderPort(Ports.IOrderPort inner, FillSimulator sim)
    {
        _inner = inner; _sim = sim;
    }

    public async Task<string> SubmitAsync(OrderIntent intent)
    {
        _sim.RegisterOrder(intent);
        try { return await _inner.SubmitAsync(intent); }
        catch { _sim.CancelOrder(intent.ClientOrderId); throw; }
    }

    public async Task<bool> CancelAsync(string exchange, string orderId)
    {
        _sim.CancelOrder(orderId);
        return await _inner.CancelAsync(exchange, orderId);
    }

    public Task<bool> AmendAsync(string exchange, string orderId, decimal? qty, decimal? price)
        => _inner.AmendAsync(exchange, orderId, qty, price);
}
