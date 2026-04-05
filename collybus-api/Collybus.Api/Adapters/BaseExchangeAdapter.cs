using Collybus.Api.Models;
using Microsoft.AspNetCore.SignalR;
using Collybus.Api.Hubs;

namespace Collybus.Api.Adapters;

public abstract class BaseExchangeAdapter
{
    protected readonly IHubContext<CollybusHub> Hub;
    protected readonly ILogger Logger;

    /// <summary>Optional callback for routing fills to the algo engine.</summary>
    public Action<Fill>? OnAlgoFill { get; set; }

    /// <summary>Optional callback for routing ticker updates to the algo engine.</summary>
    public Action<string, string, Ticker>? OnTickerUpdate { get; set; }

    /// <summary>Optional callback for routing public market trades to the algo engine.</summary>
    public Action<string, string, decimal, decimal, string, long>? OnTradeUpdate { get; set; }

    /// <summary>Optional callback for routing order cancellations/rejections to the algo engine.</summary>
    public Action<string, string, string>? OnAlgoOrderCancelled { get; set; } // (venue, orderId, label)

    private readonly Dictionary<string, Dictionary<decimal, decimal>> _bids = new();
    private readonly Dictionary<string, Dictionary<decimal, decimal>> _asks = new();
    private readonly Dictionary<string, long> _lastBookSend = new();
    private readonly Dictionary<string, Ticker> _lastTicker = new();

    // Cached blotter state for re-push on new connections
    protected readonly Dictionary<string, Position> CachedPositions = new();
    protected readonly Dictionary<string, Balance> CachedBalances = new();

    protected BaseExchangeAdapter(IHubContext<CollybusHub> hub, ILogger logger)
    {
        Hub = hub;
        Logger = logger;
    }

    public abstract string Venue { get; }

    // ── Order Book ──

    protected void ClearBook(string symbol)
    {
        _bids[symbol] = new();
        _asks[symbol] = new();
    }

    protected void ApplyBookSnapshot(string symbol, IEnumerable<(decimal Price, decimal Size, string Side)> levels)
    {
        _bids[symbol] = new();
        _asks[symbol] = new();
        foreach (var (price, size, side) in levels)
        {
            if (price <= 0) continue;
            if (side is "Buy" or "bid" or "bids") _bids[symbol][price] = size;
            else if (side is "Sell" or "ask" or "asks") _asks[symbol][price] = size;
        }
        PushBook(symbol);
    }

    protected void ApplyBookDelta(string symbol, IEnumerable<(decimal Price, decimal Size, string Side, string Action)> levels)
    {
        if (!_bids.ContainsKey(symbol)) _bids[symbol] = new();
        if (!_asks.ContainsKey(symbol)) _asks[symbol] = new();

        foreach (var (price, size, side, action) in levels)
        {
            if (price <= 0) continue;
            if (action == "delete" || size == 0)
            {
                if (side is "Buy" or "bid" or "bids")
                    _bids[symbol].Remove(price);
                else if (side is "Sell" or "ask" or "asks")
                    _asks[symbol].Remove(price);
                else
                {
                    // Unknown side — remove from both
                    _bids[symbol].Remove(price);
                    _asks[symbol].Remove(price);
                }
            }
            else if (side is "Buy" or "bid" or "bids")
                _bids[symbol][price] = size;
            else if (side is "Sell" or "ask" or "asks")
                _asks[symbol][price] = size;
        }

        PushBook(symbol, throttleMs: 100);
    }

    protected void PushBook(string symbol, int throttleMs = 0)
    {
        if (!_bids.ContainsKey(symbol) || !_asks.ContainsKey(symbol)) return;

        if (throttleMs > 0)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (_lastBookSend.TryGetValue(symbol, out var last) && now - last < throttleMs) return;
            _lastBookSend[symbol] = now;
        }

        var book = new OrderBook
        {
            Symbol = symbol, Exchange = Venue,
            Bids = _bids[symbol].OrderByDescending(kv => kv.Key).Take(25)
                .Select(kv => new OrderBookLevel(kv.Key, kv.Value)).ToList(),
            Asks = _asks[symbol].OrderBy(kv => kv.Key).Take(25)
                .Select(kv => new OrderBookLevel(kv.Key, kv.Value)).ToList(),
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };

        if (book.Bids.Count == 0 || book.Asks.Count == 0)
            Logger.LogWarning("[Book] {Venue}:{Symbol} ONE-SIDED bids={B} asks={A}",
                Venue, symbol, book.Bids.Count, book.Asks.Count);

        _ = Hub.Clients.All.SendAsync("OrderBookUpdate", new { key = $"{Venue}:{symbol}", book });
    }

    // ── Ticker ──

    protected void MergeTicker(string symbol,
        decimal? bid = null, decimal? ask = null, decimal? last = null,
        decimal? mark = null, decimal? funding = null,
        decimal? high = null, decimal? low = null, decimal? change = null,
        decimal? volume = null, decimal? index = null, decimal? oi = null)
    {
        if (!_lastTicker.TryGetValue(symbol, out var t))
            t = new Ticker { Symbol = symbol, Exchange = Venue };

        t = t with
        {
            BestBid = bid > 0 ? bid.Value : t.BestBid,
            BestAsk = ask > 0 ? ask.Value : t.BestAsk,
            LastPrice = last > 0 ? last.Value : t.LastPrice,
            MarkPrice = mark > 0 ? mark.Value : t.MarkPrice,
            FundingRate = funding ?? t.FundingRate,
            High24h = high > 0 ? high.Value : t.High24h,
            Low24h = low > 0 ? low.Value : t.Low24h,
            Change24h = change.HasValue ? change.Value : t.Change24h,
            Volume24h = volume.HasValue ? volume.Value : t.Volume24h,
            IndexPrice = index > 0 ? index.Value : t.IndexPrice,
            OpenInterest = oi > 0 ? oi.Value : t.OpenInterest,
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };

        _lastTicker[symbol] = t;

        if (t.BestBid > 0 || t.BestAsk > 0 || t.LastPrice > 0)
        {
            _ = Hub.Clients.All.SendAsync("TickerUpdate", new { key = $"{Venue}:{symbol}", ticker = t });
            OnTickerUpdate?.Invoke(Venue, symbol, t);
        }
    }

    protected virtual void ClearSymbolState(string symbol)
    {
        _bids.Remove(symbol);
        _asks.Remove(symbol);
        _lastBookSend.Remove(symbol);
        _lastTicker.Remove(symbol);
    }

    protected void CacheAndPushPosition(Position position)
    {
        var key = $"{position.Exchange}:{position.Symbol}";
        CachedPositions[key] = position;
        _ = Hub.Clients.All.SendAsync("PositionUpdate", position);
    }

    protected void CacheAndPushBalance(Balance balance)
    {
        var key = $"{balance.Exchange}:{balance.Currency}";
        CachedBalances[key] = balance;
        _ = Hub.Clients.All.SendAsync("BalanceUpdate", balance);
    }

    public async Task RepushCachedStateAsync()
    {
        foreach (var p in CachedPositions.Values)
            await Hub.Clients.All.SendAsync("PositionUpdate", p);
        foreach (var b in CachedBalances.Values)
            await Hub.Clients.All.SendAsync("BalanceUpdate", b);
    }
}
