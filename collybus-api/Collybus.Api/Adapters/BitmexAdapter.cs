using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Collybus.Api.Models;
using Collybus.Api.Services;
using Microsoft.AspNetCore.SignalR;
using Collybus.Api.Hubs;

namespace Collybus.Api.Adapters;

public class BitmexAdapter : BaseExchangeAdapter, IExchangeAdapter
{
    public override string Venue => "BITMEX";
    private readonly bool _testnet;
    private ClientWebSocket? _ws;
    private CancellationTokenSource _cts = new();
    private readonly HashSet<string> _subscriptions = [];
    private readonly Dictionary<string, Dictionary<long, decimal>> _idToPrice = new();
    private TaskCompletionSource _ready = new();
    private bool _dead;

    private string WsUrl => _testnet
        ? "wss://testnet.bitmex.com/realtime"
        : "wss://ws.bitmex.com/realtime";

    public BitmexAdapter(ILogger<BitmexAdapter> logger, IHubContext<CollybusHub> hub, bool testnet = true)
        : base(hub, logger)
    {
        _testnet = testnet;
    }

    public async Task ConnectAsync(CancellationToken ct = default)
    {
        if (_ws?.State == WebSocketState.Open) return;
        _ready = new TaskCompletionSource();
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _ws = new ClientWebSocket();
        await _ws.ConnectAsync(new Uri(WsUrl), ct);
        Logger.LogInformation("[BitMEX] Connected to {Url}", WsUrl);
        _ = Task.Run(() => ReceiveLoopAsync(_cts.Token), _cts.Token);
    }

    public async Task SubscribeAsync(string venueSymbol)
    {
        _subscriptions.Add(venueSymbol);
        ClearSymbolState(venueSymbol);
        Logger.LogInformation("[BitMEX] Subscribing to {Symbol}", venueSymbol);
        if (_ws?.State != WebSocketState.Open) await ConnectAsync();
        await Task.WhenAny(_ready.Task, Task.Delay(5000));
        await SendAsync(new {
            op = "subscribe",
            args = new[] {
                $"orderBookL2_25:{venueSymbol}",
                $"quote:{venueSymbol}",
                $"instrument:{venueSymbol}",
            }
        });
    }

    public async Task UnsubscribeAsync(string venueSymbol)
    {
        _subscriptions.Remove(venueSymbol);
        ClearSymbolState(venueSymbol);
        if (_ws?.State != WebSocketState.Open) return;
        await SendAsync(new {
            op = "unsubscribe",
            args = new[] {
                $"orderBookL2_25:{venueSymbol}",
                $"quote:{venueSymbol}",
                $"instrument:{venueSymbol}",
            }
        });
    }

    public Task SubscribePrivateAsync(ExchangeCredentials credentials) => Task.CompletedTask;
    public Task<OrderResult> SubmitOrderAsync(SubmitOrderRequest request, ExchangeCredentials credentials)
        => Task.FromResult(new OrderResult { Ok = false, RejectReason = "Not implemented" });
    public Task<OrderResult> CancelOrderAsync(string venueOrderId, ExchangeCredentials credentials)
        => Task.FromResult(new OrderResult { Ok = false, RejectReason = "Not implemented" });

    public void Disconnect() { _dead = true; _cts.Cancel(); _ws?.Abort(); }

    private async Task SendAsync(object msg)
    {
        if (_ws?.State != WebSocketState.Open) return;
        var json = JsonSerializer.Serialize(msg);
        await _ws.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, _cts.Token);
    }

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var buffer = new byte[65536];
        var sb = new StringBuilder();
        while (!_dead && !ct.IsCancellationRequested)
        {
            try
            {
                while (!ct.IsCancellationRequested && _ws?.State == WebSocketState.Open)
                {
                    sb.Clear();
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await _ws.ReceiveAsync(buffer, ct);
                        sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                    } while (!result.EndOfMessage);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    var msg = sb.ToString();
                    _ = Task.Run(() => OnMessage(msg), ct);
                }
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Logger.LogWarning("[BitMEX] Connection lost: {Err}", ex.Message); }

            if (_subscriptions.Count == 0 || _dead || ct.IsCancellationRequested) return;

            Logger.LogInformation("[BitMEX] Reconnecting in 2s ({Count} subscriptions)...", _subscriptions.Count);
            try { await Task.Delay(2000, ct); } catch { return; }
            try
            {
                _ready = new TaskCompletionSource();
                _ws = new ClientWebSocket();
                await _ws.ConnectAsync(new Uri(WsUrl), ct);
                Logger.LogInformation("[BitMEX] Reconnected, waiting for welcome...");
                await Task.WhenAny(_ready.Task, Task.Delay(5000));
                foreach (var sym in _subscriptions.ToList())
                {
                    await SendAsync(new { op = "subscribe", args = new[] {
                        $"orderBookL2_25:{sym}", $"quote:{sym}", $"instrument:{sym}" } });
                }
            }
            catch (Exception ex)
            {
                Logger.LogWarning("[BitMEX] Reconnect failed: {Err}", ex.Message);
            }
        }
    }

    private void OnMessage(string raw)
    {
        JsonNode? msg;
        try { msg = JsonNode.Parse(raw); } catch { return; }
        if (msg is null) return;

        var table = msg["table"]?.GetValue<string>() ?? "";
        var action = msg["action"]?.GetValue<string>() ?? "";

        if (msg["info"] != null || msg["docs"] != null) { _ready.TrySetResult(); return; }
        if (msg["success"] != null) { Logger.LogInformation("[BitMEX] Subscribe confirmed: {Sub}", msg["subscribe"]?.GetValue<string>() ?? ""); return; }
        if (msg["error"] != null) { Logger.LogError("[BitMEX] Error: {Err}", msg["error"]); return; }

        if (!string.IsNullOrEmpty(table))
            Logger.LogDebug("[BitMEX] {Table} {Action} {Count} items", table, action, (msg["data"] as JsonArray)?.Count ?? 0);

        var data = msg["data"];
        if (data is not JsonArray arr || arr.Count == 0) return;

        if (table == "instrument") HandleInstrument(arr);
        else if (table == "orderBookL2_25") HandleOrderBook(arr, action);
        else if (table == "quote") HandleQuote(arr);
    }

    private void HandleOrderBook(JsonArray arr, string action)
    {
        var bySymbol = arr.Where(i => i != null)
            .GroupBy(i => i!["symbol"]?.GetValue<string>() ?? "")
            .Where(g => !string.IsNullOrEmpty(g.Key));

        foreach (var group in bySymbol)
        {
            var symbol = group.Key;
            if (!_idToPrice.ContainsKey(symbol)) _idToPrice[symbol] = new();

            if (action == "partial")
            {
                _idToPrice[symbol].Clear();
                var levels = new List<(decimal Price, decimal Size, string Side)>();
                foreach (var item in group)
                {
                    var id = item!["id"]?.GetValue<long?>() ?? 0;
                    var price = item["price"]?.GetValue<decimal?>() ?? 0;
                    var size = item["size"]?.GetValue<decimal?>() ?? 0;
                    var side = item["side"]?.GetValue<string>() ?? "";
                    if (price > 0) { _idToPrice[symbol][id] = price; levels.Add((price, size, side)); }
                }
                ApplyBookSnapshot(symbol, levels);
            }
            else if (action == "delete")
            {
                var deltas = new List<(decimal Price, decimal Size, string Side, string Action)>();
                foreach (var item in group)
                {
                    var id = item!["id"]?.GetValue<long?>() ?? 0;
                    if (!_idToPrice[symbol].TryGetValue(id, out var price)) continue;
                    _idToPrice[symbol].Remove(id);
                    deltas.Add((price, 0, "", "delete"));
                }
                if (deltas.Count > 0) ApplyBookDelta(symbol, deltas);
            }
            else // insert or update
            {
                var deltas = new List<(decimal Price, decimal Size, string Side, string Action)>();
                foreach (var item in group)
                {
                    var id = item!["id"]?.GetValue<long?>() ?? 0;
                    var price = item["price"]?.GetValue<decimal?>() ?? 0;
                    var size = item["size"]?.GetValue<decimal?>() ?? 0;
                    var side = item["side"]?.GetValue<string>() ?? "";
                    if (price == 0 && _idToPrice[symbol].TryGetValue(id, out var cached)) price = cached;
                    if (price > 0)
                    {
                        _idToPrice[symbol][id] = price;
                        deltas.Add((price, size, side, "update"));
                    }
                }
                if (deltas.Count > 0) ApplyBookDelta(symbol, deltas);
            }
        }
    }

    protected override void ClearSymbolState(string symbol)
    {
        base.ClearSymbolState(symbol);
        _idToPrice.Remove(symbol);
    }

    private void HandleQuote(JsonArray arr)
    {
        foreach (var item in arr)
        {
            if (item is null) continue;
            var symbol = item["symbol"]?.GetValue<string>() ?? "";
            MergeTicker(symbol,
                bid: item["bidPrice"]?.GetValue<decimal?>(),
                ask: item["askPrice"]?.GetValue<decimal?>());
        }
    }

    private void HandleInstrument(JsonArray arr)
    {
        foreach (var item in arr)
        {
            if (item is null) continue;
            var symbol = item["symbol"]?.GetValue<string>() ?? "";
            MergeTicker(symbol,
                bid: item["bidPrice"]?.GetValue<decimal?>(),
                ask: item["askPrice"]?.GetValue<decimal?>(),
                last: item["lastPrice"]?.GetValue<decimal?>(),
                mark: item["markPrice"]?.GetValue<decimal?>(),
                funding: item["fundingRate"]?.GetValue<decimal?>(),
                high: item["highPrice"]?.GetValue<decimal?>(),
                low: item["lowPrice"]?.GetValue<decimal?>(),
                volume: item["volume24h"]?.GetValue<decimal?>());
        }
    }

}
