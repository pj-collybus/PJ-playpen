using System.Net.WebSockets;
using System.Security.Cryptography;
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
    private readonly Dictionary<string, Dictionary<long, (decimal Price, string Side, decimal Size)>> _bookEntries = new();
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

    public async Task SubscribePrivateAsync(ExchangeCredentials credentials)
    {
        var apiKey = credentials.Fields.GetValueOrDefault("apiKey") ?? "";
        var apiSecret = credentials.Fields.GetValueOrDefault("apiSecret") ?? "";
        if (string.IsNullOrEmpty(apiKey) || string.IsNullOrEmpty(apiSecret))
            throw new InvalidOperationException("BitMEX API key/secret not configured");

        if (_ws?.State != WebSocketState.Open) await ConnectAsync();
        await Task.WhenAny(_ready.Task, Task.Delay(5000));

        // BitMEX WS auth: HMAC-SHA256 of "GET/realtime{expires}" with apiSecret
        var expires = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 60;
        var sigData = $"GET/realtime{expires}";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(apiSecret));
        var sig = Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(sigData))).ToLower();

        await SendAsync(new { op = "authKeyExpires", args = new object[] { apiKey, expires, sig } });
        Logger.LogInformation("[BitMEX] Auth sent, waiting for confirmation...");

        // Wait for auth confirmation then subscribe to private channels
        await Task.Delay(1000);
        await SendAsync(new
        {
            op = "subscribe",
            args = new[]
            {
                "order",
                "execution",
                "position",
                "margin",
                "wallet",
            }
        });
        Logger.LogInformation("[BitMEX] Private channels subscribed");
    }

    public async Task<OrderResult> SubmitOrderAsync(SubmitOrderRequest request, ExchangeCredentials credentials)
    {
        var apiKey = credentials.Fields.GetValueOrDefault("apiKey") ?? "";
        var apiSecret = credentials.Fields.GetValueOrDefault("apiSecret") ?? "";

        var path = "/api/v1/order";
        var expires = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 60;
        var body = JsonSerializer.Serialize(new
        {
            symbol = request.Symbol,
            side = request.Side.Equals("BUY", StringComparison.OrdinalIgnoreCase) ? "Buy" : "Sell",
            orderQty = (int)request.Quantity,
            price = request.LimitPrice,
            ordType = "Limit",
            timeInForce = request.TimeInForce?.ToUpperInvariant() switch
            {
                "FOK" => "FillOrKill",
                "IOC" => "ImmediateOrCancel",
                _ => "GoodTillCancel",
            },
            text = "Collybus",
        });

        var sig = ComputeHmac(apiSecret, $"POST{path}{expires}{body}");
        var baseUrl = _testnet ? "https://testnet.bitmex.com" : "https://www.bitmex.com";
        using var http = new HttpClient();
        var req = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}{path}");
        req.Headers.Add("api-key", apiKey);
        req.Headers.Add("api-expires", expires.ToString());
        req.Headers.Add("api-signature", sig);
        req.Content = new StringContent(body, Encoding.UTF8, "application/json");

        var r = await http.SendAsync(req);
        var json = await r.Content.ReadAsStringAsync();
        var doc = JsonNode.Parse(json);

        if (!r.IsSuccessStatusCode)
        {
            var error = doc?["error"]?["message"]?.GetValue<string>() ?? json;
            return new OrderResult { Ok = false, RejectReason = error };
        }

        return new OrderResult
        {
            Ok = true,
            VenueOrderId = doc?["orderID"]?.GetValue<string>(),
            Status = doc?["ordStatus"]?.GetValue<string>()?.ToLower() ?? "open",
            FilledQty = doc?["cumQty"]?.GetValue<decimal?>() ?? 0,
            AvgFillPrice = doc?["avgPx"]?.GetValue<decimal?>() ?? 0,
        };
    }

    public async Task<OrderResult> CancelOrderAsync(string venueOrderId, ExchangeCredentials credentials)
    {
        var apiKey = credentials.Fields.GetValueOrDefault("apiKey") ?? "";
        var apiSecret = credentials.Fields.GetValueOrDefault("apiSecret") ?? "";

        var path = "/api/v1/order";
        var expires = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 60;
        var body = JsonSerializer.Serialize(new { orderID = venueOrderId });

        var sig = ComputeHmac(apiSecret, $"DELETE{path}{expires}{body}");
        var baseUrl = _testnet ? "https://testnet.bitmex.com" : "https://www.bitmex.com";
        using var http = new HttpClient();
        var req = new HttpRequestMessage(HttpMethod.Delete, $"{baseUrl}{path}");
        req.Headers.Add("api-key", apiKey);
        req.Headers.Add("api-expires", expires.ToString());
        req.Headers.Add("api-signature", sig);
        req.Content = new StringContent(body, Encoding.UTF8, "application/json");

        var r = await http.SendAsync(req);
        if (!r.IsSuccessStatusCode)
        {
            var json = await r.Content.ReadAsStringAsync();
            var error = JsonNode.Parse(json)?["error"]?["message"]?.GetValue<string>() ?? json;
            return new OrderResult { Ok = false, RejectReason = error };
        }
        return new OrderResult { Ok = true, VenueOrderId = venueOrderId, Status = "cancelled" };
    }

    private static string ComputeHmac(string secret, string message)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(message))).ToLower();
    }

    public async Task<OrderResult> AmendOrderAsync(string orderId, decimal? newQty, decimal? newPrice, ExchangeCredentials credentials)
    {
        var body = new Dictionary<string, object> { ["orderID"] = orderId };
        if (newQty.HasValue) body["orderQty"] = (int)newQty.Value;
        if (newPrice.HasValue) body["price"] = newPrice.Value;
        var bodyJson = JsonSerializer.Serialize(body);
        var path = "/api/v1/order";
        var expires = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 60;
        var apiKey = credentials.Fields.GetValueOrDefault("apiKey") ?? "";
        var apiSecret = credentials.Fields.GetValueOrDefault("apiSecret") ?? "";
        var sig = ComputeHmac(apiSecret, $"PUT{path}{expires}{bodyJson}");
        var baseUrl = _testnet ? "https://testnet.bitmex.com" : "https://www.bitmex.com";
        using var http = new HttpClient();
        var req = new HttpRequestMessage(HttpMethod.Put, $"{baseUrl}{path}");
        req.Headers.Add("api-key", apiKey);
        req.Headers.Add("api-expires", expires.ToString());
        req.Headers.Add("api-signature", sig);
        req.Content = new StringContent(bodyJson, Encoding.UTF8, "application/json");
        var r = await http.SendAsync(req);
        var json = await r.Content.ReadAsStringAsync();
        var doc = JsonNode.Parse(json);
        if (!r.IsSuccessStatusCode)
            return new OrderResult { Ok = false, RejectReason = doc?["error"]?["message"]?.GetValue<string>() ?? json };
        return new OrderResult { Ok = true, VenueOrderId = doc?["orderID"]?.GetValue<string>(), Status = "open" };
    }

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
        else if (table == "order") HandlePrivateOrder(arr, action);
        else if (table == "execution" && action != "partial") HandlePrivateExecution(arr);
        else if (table == "position") HandlePrivatePosition(arr);
        else if (table == "margin" || table == "wallet") HandlePrivateMargin(arr);
    }

    private void HandleOrderBook(JsonArray arr, string action)
    {
        var bySymbol = arr.Where(i => i != null)
            .GroupBy(i => i!["symbol"]?.GetValue<string>() ?? "")
            .Where(g => !string.IsNullOrEmpty(g.Key));

        foreach (var group in bySymbol)
        {
            var symbol = group.Key;
            if (!_bookEntries.ContainsKey(symbol))
                _bookEntries[symbol] = new();
            var book = _bookEntries[symbol];

            if (action == "partial" || action == "insert")
            {
                if (action == "partial") book.Clear();
                foreach (var item in group)
                {
                    var id = item!["id"]?.GetValue<long?>() ?? 0;
                    var price = item["price"]?.GetValue<decimal?>() ?? 0;
                    var side = item["side"]?.GetValue<string>() ?? "";
                    var size = item["size"]?.GetValue<decimal?>() ?? 0;
                    if (id > 0 && price > 0) book[id] = (price, side, size);
                }
            }
            else if (action == "update")
            {
                foreach (var item in group)
                {
                    var id = item!["id"]?.GetValue<long?>() ?? 0;
                    var size = item["size"]?.GetValue<decimal?>() ?? 0;
                    if (id > 0 && book.TryGetValue(id, out var existing))
                        book[id] = (existing.Price, existing.Side, size);
                }
            }
            else if (action == "delete")
            {
                foreach (var item in group)
                {
                    var id = item!["id"]?.GetValue<long?>() ?? 0;
                    if (id > 0) book.Remove(id);
                }
            }

            // Rebuild and push via base class
            ApplyBookSnapshot(symbol,
                book.Values.Where(e => e.Size > 0)
                    .Select(e => (e.Price, e.Size, e.Side == "Buy" ? "bid" : "ask")));
        }
    }

    protected override void ClearSymbolState(string symbol)
    {
        base.ClearSymbolState(symbol);
        _bookEntries.Remove(symbol);
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

    // ── Private channel handlers ──────────────────────────────────────────────

    private void HandlePrivateOrder(JsonArray arr, string action)
    {
        foreach (var o in arr)
        {
            if (o is null) continue;
            var status = o["ordStatus"]?.GetValue<string>() ?? "";
            var state = status switch
            {
                "Filled" => OrderState.Filled,
                "Canceled" or "Cancelled" => OrderState.Cancelled,
                "Rejected" => OrderState.Rejected,
                "PartiallyFilled" => OrderState.PartiallyFilled,
                _ => OrderState.Open,
            };
            var qty = o["orderQty"]?.GetValue<decimal?>() ?? 0;
            var filled = o["cumQty"]?.GetValue<decimal?>() ?? 0;

            var order = new Order
            {
                OrderId = o["orderID"]?.GetValue<string>() ?? "",
                Exchange = Venue,
                Symbol = o["symbol"]?.GetValue<string>() ?? "",
                Side = o["side"]?.GetValue<string>() == "Buy" ? OrderSide.Buy : OrderSide.Sell,
                OrderType = o["ordType"]?.GetValue<string>() == "Market" ? OrderType.Market : OrderType.Limit,
                Quantity = qty,
                FilledQuantity = filled,
                RemainingQuantity = o["leavesQty"]?.GetValue<decimal?>() ?? (qty - filled),
                LimitPrice = o["price"]?.GetValue<decimal?>(),
                AvgFillPrice = o["avgPx"]?.GetValue<decimal?>(),
                State = state,
                CreatedAt = ParseBitmexTimestamp(o["timestamp"]?.GetValue<string>()),
                UpdatedAt = ParseBitmexTimestamp(o["timestamp"]?.GetValue<string>()),
            };
            _ = Hub.Clients.All.SendAsync("OrderUpdate", order);
        }
    }

    private void HandlePrivateExecution(JsonArray arr)
    {
        foreach (var t in arr)
        {
            if (t is null) continue;
            var execType = t["execType"]?.GetValue<string>() ?? "";
            if (execType != "Trade") continue; // Only trade executions

            var fill = new Fill
            {
                FillId = t["execID"]?.GetValue<string>() ?? "",
                OrderId = t["orderID"]?.GetValue<string>() ?? "",
                Exchange = Venue,
                Symbol = t["symbol"]?.GetValue<string>() ?? "",
                Side = t["side"]?.GetValue<string>() == "Buy" ? OrderSide.Buy : OrderSide.Sell,
                FillPrice = t["lastPx"]?.GetValue<decimal?>() ?? 0,
                FillSize = t["lastQty"]?.GetValue<decimal?>() ?? 0,
                FillTs = ParseBitmexTimestamp(t["timestamp"]?.GetValue<string>()),
                Commission = t["commission"]?.GetValue<decimal?>() ?? 0,
            };
            _ = Hub.Clients.All.SendAsync("FillUpdate", fill);
        }
    }

    private void HandlePrivatePosition(JsonArray arr)
    {
        foreach (var p in arr)
        {
            if (p is null) continue;
            var qty = p["currentQty"]?.GetValue<decimal?>() ?? 0;

            var position = new Position
            {
                Exchange = Venue,
                Symbol = p["symbol"]?.GetValue<string>() ?? "",
                Side = qty > 0 ? "LONG" : qty < 0 ? "SHORT" : "FLAT",
                Size = Math.Abs(qty),
                SizeUnit = "contracts",
                AvgEntryPrice = p["avgEntryPrice"]?.GetValue<decimal?>() ?? 0,
                MarkPrice = p["markPrice"]?.GetValue<decimal?>() ?? 0,
                UnrealisedPnl = p["unrealisedPnl"]?.GetValue<decimal?>() ?? 0,
                LiquidationPrice = p["liquidationPrice"]?.GetValue<decimal?>() ?? 0,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            CacheAndPushPosition(position);
        }
    }

    private void HandlePrivateMargin(JsonArray arr)
    {
        foreach (var m in arr)
        {
            if (m is null) continue;
            var currency = m["currency"]?.GetValue<string>()?.ToUpperInvariant() ?? "";
            if (string.IsNullOrEmpty(currency)) continue;

            // BitMEX margin values are in satoshis for XBt — convert to BTC
            var divisor = currency == "XBT" ? 100_000_000m : 1m;

            var balance = new Balance
            {
                Exchange = Venue,
                Currency = currency == "XBT" ? "BTC" : currency,
                Available = (m["availableMargin"]?.GetValue<decimal?>() ?? 0) / divisor,
                Total = (m["walletBalance"]?.GetValue<decimal?>() ?? 0) / divisor,
                UnrealisedPnl = (m["unrealisedPnl"]?.GetValue<decimal?>() ?? 0) / divisor,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            CacheAndPushBalance(balance);
        }
    }

    private static long ParseBitmexTimestamp(string? ts)
    {
        if (ts == null) return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return DateTimeOffset.TryParse(ts, out var dt) ? dt.ToUnixTimeMilliseconds() : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    // ── REST history ──────────────────────────────────────────────────────────

    public async Task<List<object>> FetchOrderHistoryAsync(ExchangeCredentials creds, DateTime from, DateTime to)
    {
        var path = $"/api/v1/order?count=200&reverse=true&startTime={from:yyyy-MM-ddTHH:mm:ss.fffZ}&endTime={to:yyyy-MM-ddTHH:mm:ss.fffZ}";
        var result = await SignedGetAsync(creds, path);
        if (result is not JsonArray arr) return [];
        Logger.LogInformation("[BitMEX] FetchOrderHistory: {Count} orders", arr.Count);
        return arr.Select(o => (object)new
        {
            id = o?["orderID"]?.GetValue<string>() ?? "",
            exchange = "BITMEX",
            timestamp = ParseBitmexTimestamp(o?["timestamp"]?.GetValue<string>()),
            instrument = o?["symbol"]?.GetValue<string>() ?? "",
            type = o?["ordType"]?.GetValue<string>()?.ToUpper() ?? "LIMIT",
            side = o?["side"]?.GetValue<string>()?.ToUpper() ?? "",
            amount = o?["orderQty"]?.GetValue<decimal?>() ?? 0,
            filled = o?["cumQty"]?.GetValue<decimal?>() ?? 0,
            price = o?["price"]?.GetValue<decimal?>() ?? 0,
            status = MapBitmexOrderStatus(o?["ordStatus"]?.GetValue<string>() ?? ""),
        }).ToList();
    }

    public async Task<List<object>> FetchTradeHistoryAsync(ExchangeCredentials creds, DateTime from, DateTime to)
    {
        var filter = Uri.EscapeDataString("{\"execType\":\"Trade\"}");
        var path = $"/api/v1/execution?count=200&reverse=true&filter={filter}&startTime={from:yyyy-MM-ddTHH:mm:ss.fffZ}&endTime={to:yyyy-MM-ddTHH:mm:ss.fffZ}";
        var result = await SignedGetAsync(creds, path);
        if (result is not JsonArray arr) return [];
        Logger.LogInformation("[BitMEX] FetchTradeHistory: {Count} trades", arr.Count);
        return arr.Select(t => (object)new
        {
            id = t?["execID"]?.GetValue<string>() ?? "",
            exchange = "BITMEX",
            timestamp = ParseBitmexTimestamp(t?["timestamp"]?.GetValue<string>()),
            instrument = t?["symbol"]?.GetValue<string>() ?? "",
            side = t?["side"]?.GetValue<string>()?.ToUpper() ?? "",
            amount = t?["lastQty"]?.GetValue<decimal?>() ?? 0,
            price = t?["lastPx"]?.GetValue<decimal?>() ?? 0,
            fee = t?["commission"]?.GetValue<decimal?>() ?? 0,
            orderId = t?["orderID"]?.GetValue<string>() ?? "",
        }).ToList();
    }

    private async Task<JsonNode?> SignedGetAsync(ExchangeCredentials creds, string path)
    {
        var apiKey = creds.Fields.GetValueOrDefault("apiKey") ?? "";
        var apiSecret = creds.Fields.GetValueOrDefault("apiSecret") ?? "";
        var expires = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 60;
        var sig = ComputeHmac(apiSecret, $"GET{path}{expires}");

        var baseUrl = _testnet ? "https://testnet.bitmex.com" : "https://www.bitmex.com";
        using var http = new HttpClient();
        var req = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}{path}");
        req.Headers.Add("api-key", apiKey);
        req.Headers.Add("api-expires", expires.ToString());
        req.Headers.Add("api-signature", sig);

        var r = await http.SendAsync(req);
        var body = await r.Content.ReadAsStringAsync();
        return JsonNode.Parse(body);
    }

    private static string MapBitmexOrderStatus(string status) => status switch
    {
        "New" => "open",
        "PartiallyFilled" => "partial",
        "Filled" => "filled",
        "Canceled" => "cancelled",
        "Rejected" => "rejected",
        _ => status.ToLower(),
    };
}
