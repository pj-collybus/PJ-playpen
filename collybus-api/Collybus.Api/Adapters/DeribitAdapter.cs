using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Collybus.Api.Models;
using Collybus.Api.Services;
using Microsoft.AspNetCore.SignalR;
using Collybus.Api.Hubs;

namespace Collybus.Api.Adapters;

public class DeribitAdapter : BaseExchangeAdapter, IExchangeAdapter
{
    public override string Venue => "DERIBIT";

    private readonly IBlotterService _blotter;
    private readonly bool _testnet;

    private ClientWebSocket? _ws;
    private int _reqId = 1;
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonNode?>> _pending = new();
    private readonly HashSet<string> _subscriptions = [];
    private bool _dead;
    private CancellationTokenSource _cts = new();

    private string WsUrl => _testnet
        ? "wss://test.deribit.com/ws/api/v2"
        : "wss://www.deribit.com/ws/api/v2";

    private string RestBase => _testnet
        ? "https://test.deribit.com/api/v2"
        : "https://www.deribit.com/api/v2";

    public DeribitAdapter(
        ILogger<DeribitAdapter> logger,
        IHubContext<CollybusHub> hub,
        IBlotterService blotter,
        bool testnet = true)
        : base(hub, logger)
    {
        _blotter = blotter;
        _testnet = testnet;
    }

    public async Task ConnectAsync(CancellationToken ct = default)
    {
        if (_ws?.State == WebSocketState.Open)
        {
            Logger.LogInformation("[Deribit] Already connected, skipping reconnect");
            return;
        }
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _ws = new ClientWebSocket();
        await _ws.ConnectAsync(new Uri(WsUrl), ct);
        Logger.LogInformation("[Deribit] Connected to {Url}", WsUrl);
        _ = Task.Run(() => ReceiveLoopAsync(_cts.Token), _cts.Token);
    }

    public async Task SubscribeAsync(string venueSymbol)
    {
        _subscriptions.Add(venueSymbol);
        if (_ws?.State != System.Net.WebSockets.WebSocketState.Open)
        {
            Logger.LogWarning("[Deribit] WebSocket not connected, connecting before subscribe");
            await ConnectAsync();
        }
        var channels = new[] { $"book.{venueSymbol}.100ms", $"ticker.{venueSymbol}.100ms" };
        await RpcAsync("public/subscribe", new { channels });
    }

    public async Task UnsubscribeAsync(string venueSymbol)
    {
        _subscriptions.Remove(venueSymbol);
        ClearSymbolState(venueSymbol);
        if (_ws?.State != System.Net.WebSockets.WebSocketState.Open) return;
        try
        {
            var channels = new[] { $"book.{venueSymbol}.100ms", $"ticker.{venueSymbol}.100ms" };
            await RpcAsync("public/unsubscribe", new { channels });
        }
        catch (Exception ex)
        {
            Logger.LogWarning("[Deribit] Unsubscribe failed for {Symbol}: {Err}", venueSymbol, ex.Message);
        }
    }

    public async Task SubscribePrivateAsync(ExchangeCredentials credentials)
    {
        var clientId = credentials.Fields.GetValueOrDefault("clientId") ?? "";
        var clientSecret = credentials.Fields.GetValueOrDefault("clientSecret") ?? "";

        if (string.IsNullOrEmpty(clientId))
            throw new InvalidOperationException("No clientId in credentials");

        await RpcAsync("public/auth", new
        {
            grant_type = "client_credentials",
            client_id = clientId,
            client_secret = clientSecret
        });

        var channels = new[]
        {
            "user.trades.any.any.raw",
            "user.orders.any.any.raw",
            "user.changes.any.any.raw",
            "user.portfolio.btc",
            "user.portfolio.eth",
            "user.portfolio.usdc"
        };

        await RpcAsync("private/subscribe", new { channels });
        Logger.LogInformation("[Deribit] Private channels subscribed");

        _ = Task.Run(async () =>
        {
            try { await FetchInitialPositionsAsync(); }
            catch (Exception ex) { Logger.LogError(ex, "[Deribit] Initial positions failed"); }
        });
    }

    public async Task<OrderResult> SubmitOrderAsync(SubmitOrderRequest request, ExchangeCredentials credentials)
    {
        try
        {
            var token = await AuthenticateAsync(credentials);
            var venueSymbol = MapSymbol(request.Symbol);
            var method = request.Side.Equals("BUY", StringComparison.OrdinalIgnoreCase)
                ? "private/buy" : "private/sell";
            var tif = MapTif(request.TimeInForce);
            var clientOid = $"CLBX-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";

            var result = await RpcAsync(method, new
            {
                instrument_name = venueSymbol,
                type = "limit",
                price = request.LimitPrice,
                amount = request.Quantity,
                time_in_force = tif,
                label = clientOid
            }, token);

            var order = result?["order"];
            var filled = order?["filled_amount"]?.GetValue<decimal>() ?? 0;
            var avg = order?["average_price"]?.GetValue<decimal>() ?? 0;
            var status = filled >= request.Quantity ? "FILLED" : filled > 0 ? "PARTIAL" : "OPEN";

            return new OrderResult
            {
                Ok = true,
                VenueOrderId = order?["order_id"]?.GetValue<string>(),
                ClientOrderId = clientOid,
                Status = status,
                FilledQty = filled,
                AvgFillPrice = avg,
            };
        }
        catch (Exception ex)
        {
            return new OrderResult { Ok = false, RejectReason = ex.Message };
        }
    }

    public async Task<OrderResult> CancelOrderAsync(string venueOrderId, ExchangeCredentials credentials)
    {
        try
        {
            var token = await AuthenticateAsync(credentials);
            await RpcAsync("private/cancel", new { order_id = venueOrderId }, token);
            return new OrderResult { Ok = true, VenueOrderId = venueOrderId, Status = "CANCELLED" };
        }
        catch (Exception ex)
        {
            return new OrderResult { Ok = false, RejectReason = ex.Message };
        }
    }

    public async Task<OrderResult> AmendOrderAsync(string orderId, decimal? newQty, decimal? newPrice, ExchangeCredentials credentials)
    {
        try
        {
            var token = await AuthenticateAsync(credentials);
            var args = new Dictionary<string, object> { ["order_id"] = orderId };
            if (newQty.HasValue) args["amount"] = newQty.Value;
            if (newPrice.HasValue) args["price"] = newPrice.Value;
            var result = await RpcAsync("private/edit", args, token);
            var order = result?["order"];
            if (order == null) return new OrderResult { Ok = false, RejectReason = "Amend failed" };
            return new OrderResult
            {
                Ok = true,
                VenueOrderId = order["order_id"]?.GetValue<string>(),
                Status = order["order_state"]?.GetValue<string>()?.ToLower() ?? "open",
            };
        }
        catch (Exception ex) { return new OrderResult { Ok = false, RejectReason = ex.Message }; }
    }

    public void Disconnect()
    {
        _dead = true;
        _cts.Cancel();
        _ws?.Abort();
    }

    // ── Receive loop ──────────────────────────────────────────────────────────

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var buffer = new byte[65536];
        Logger.LogInformation("[Deribit] Receive loop started, ws state={State}", _ws?.State);

        while (!_dead && !ct.IsCancellationRequested)
        {
            try
            {
                while (!ct.IsCancellationRequested && _ws?.State == WebSocketState.Open)
                {
                    var sb = new StringBuilder();
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await _ws.ReceiveAsync(buffer, ct);
                        sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                    } while (!result.EndOfMessage);
                    if (result.MessageType == WebSocketMessageType.Close) break;
                    var raw = sb.ToString();
                    Logger.LogDebug("[Deribit] recv {Len} bytes: {Preview}", raw.Length, raw.Length > 200 ? raw[..200] : raw);
                    OnMessage(raw);
                }
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Logger.LogWarning("[Deribit] Connection lost: {Err}", ex.Message); }

            if (_subscriptions.Count == 0 || _dead || ct.IsCancellationRequested) return;

            Logger.LogInformation("[Deribit] Reconnecting in 2s ({Count} subscriptions)...", _subscriptions.Count);
            try { await Task.Delay(2000, ct); } catch { return; }
            try
            {
                _ws = new ClientWebSocket();
                await _ws.ConnectAsync(new Uri(WsUrl), ct);
                Logger.LogInformation("[Deribit] Reconnected");
                foreach (var sym in _subscriptions.ToList())
                {
                    var channels = new[] { $"book.{sym}.100ms", $"ticker.{sym}.100ms" };
                    await RpcAsync("public/subscribe", new { channels });
                }
            }
            catch (Exception ex) { Logger.LogWarning("[Deribit] Reconnect failed: {Err}", ex.Message); }
        }
    }

    private void OnMessage(string raw)
    {
        JsonNode? msg;
        try { msg = JsonNode.Parse(raw); } catch { return; }
        if (msg is null) return;

        int? id = null;
        try { if (msg["id"] is not null) id = msg["id"]!.GetValue<int>(); } catch { }
        Logger.LogDebug("[Deribit] msg id={Id} method={Method} keys={Keys}",
            id, msg["method"]?.GetValue<string>(), string.Join(",", (msg as JsonObject)?.Select(kv => kv.Key) ?? []));
        if (id.HasValue && _pending.TryRemove(id.Value, out var tcs))
        {
            var error = msg["error"];
            if (error is not null)
                tcs.TrySetException(new Exception(error["message"]?.GetValue<string>() ?? "RPC error"));
            else
                tcs.TrySetResult(msg["result"]);
            return;
        }

        var method = msg["method"]?.GetValue<string>();
        if (method == "subscription")
        {
            var channel = msg["params"]?["channel"]?.GetValue<string>() ?? "";
            var data = msg["params"]?["data"];
            var receivedTs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            OnNotification(channel, data, receivedTs);
        }
    }

    private void OnNotification(string channel, JsonNode? data, long receivedTs)
    {
        if (channel.StartsWith("ticker.")) HandleTicker(channel, data, receivedTs);
        else if (channel.StartsWith("book.")) HandleBook(channel, data, receivedTs);
        else if (channel.StartsWith("user.changes.")) HandleUserChanges(data, receivedTs);
        else if (channel.StartsWith("user.portfolio.")) HandleUserPortfolio(data, receivedTs);
        else if (channel.StartsWith("user.trades.")) HandleUserTrades(data, receivedTs);
        else if (channel.StartsWith("user.orders.")) HandleUserOrders(data, receivedTs);
    }

    private void HandleTicker(string channel, JsonNode? data, long receivedTs)
    {
        if (data is null) return;
        var venueSymbol = channel.Split('.')[1];
        MergeTicker(venueSymbol,
            bid: data["best_bid_price"]?.GetValue<decimal?>(),
            ask: data["best_ask_price"]?.GetValue<decimal?>(),
            last: data["last_price"]?.GetValue<decimal?>(),
            mark: data["mark_price"]?.GetValue<decimal?>(),
            index: data["index_price"]?.GetValue<decimal?>(),
            volume: data["stats"]?["volume"]?.GetValue<decimal?>(),
            high: data["stats"]?["high"]?.GetValue<decimal?>(),
            low: data["stats"]?["low"]?.GetValue<decimal?>(),
            change: data["price_change"]?.GetValue<decimal?>(),
            oi: data["open_interest"]?.GetValue<decimal?>(),
            funding: data["current_funding"]?.GetValue<decimal?>());
    }

    private void HandleBook(string channel, JsonNode? data, long receivedTs)
    {
        if (data is null) return;
        var venueSymbol = channel.Split('.')[1];
        var isSnapshot = data["type"]?.GetValue<string>() == "snapshot";

        if (isSnapshot)
        {
            var levels = ParseDeribitBookLevels(data["bids"], "bid")
                .Concat(ParseDeribitBookLevels(data["asks"], "ask"));
            ApplyBookSnapshot(venueSymbol, levels);
        }
        else
        {
            var deltas = ParseDeribitDeltas(data["bids"], "bid")
                .Concat(ParseDeribitDeltas(data["asks"], "ask"));
            ApplyBookDelta(venueSymbol, deltas);
        }
    }

    private static IEnumerable<(decimal Price, decimal Size, string Side)> ParseDeribitBookLevels(JsonNode? arr, string side)
    {
        if (arr is not JsonArray a) yield break;
        foreach (var item in a)
        {
            if (item is not JsonArray level) continue;
            if (level.Count >= 3)
            {
                var price = level[1]?.GetValue<decimal>() ?? 0;
                var size = level[2]?.GetValue<decimal>() ?? 0;
                if (size > 0) yield return (price, size, side);
            }
            else if (level.Count == 2)
            {
                var price = level[0]?.GetValue<decimal>() ?? 0;
                var size = level[1]?.GetValue<decimal>() ?? 0;
                if (size > 0) yield return (price, size, side);
            }
        }
    }

    private static IEnumerable<(decimal Price, decimal Size, string Side, string Action)> ParseDeribitDeltas(JsonNode? arr, string side)
    {
        if (arr is not JsonArray a) yield break;
        foreach (var item in a)
        {
            if (item is not JsonArray level || level.Count < 3) continue;
            var action = level[0]?.GetValue<string>() ?? "change";
            var price = level[1]?.GetValue<decimal>() ?? 0;
            var size = level[2]?.GetValue<decimal>() ?? 0;
            yield return (price, size, side, action == "delete" ? "delete" : "update");
        }
    }

    private void HandleUserChanges(JsonNode? data, long receivedTs)
    {
        if (data is null) return;
        var raw = data.ToJsonString();
        Logger.LogInformation("[Deribit] UserChanges raw: {Raw}", raw[..Math.Min(500, raw.Length)]);

        if (data["positions"] is JsonArray positions)
        {
            foreach (var p in positions)
            {
                if (p is null) continue;
                var instr = p["instrument_name"]?.GetValue<string>() ?? "";
                var sizeCurrency = p["size_currency"]?.GetValue<decimal?>() ?? 0;
                var size = p["size"]?.GetValue<decimal?>() ?? 0;
                var rawSize = sizeCurrency != 0 ? sizeCurrency : size;
                var direction = p["direction"]?.GetValue<string>() ?? "";
                var side = direction == "buy" ? "LONG" : direction == "sell" ? "SHORT" : "FLAT";

                var position = new Position
                {
                    Exchange = Venue,
                    Symbol = instr,
                    Side = rawSize == 0 || direction == "zero" ? "FLAT" : side,
                    Size = Math.Abs(rawSize),
                    SizeUnit = instr.Split('-')[0],
                    AvgEntryPrice = p["average_price"]?.GetValue<decimal?>() ?? 0,
                    MarkPrice = p["mark_price"]?.GetValue<decimal?>() ?? 0,
                    UnrealisedPnl = p["floating_profit_loss"]?.GetValue<decimal?>() ?? 0,
                    LiquidationPrice = p["estimated_liquidation_price"]?.GetValue<decimal?>() ?? 0,
                    Timestamp = receivedTs,
                };

                CacheAndPushPosition(position);
            }
        }
    }

    private void HandleUserTrades(JsonNode? data, long receivedTs)
    {
        var raw = data?.ToJsonString() ?? "null";
        Logger.LogInformation("[Deribit] UserTrades raw: {Raw}", raw[..Math.Min(500, raw.Length)]);
        if (data is not JsonArray trades) { Logger.LogWarning("[Deribit] UserTrades data is NOT JsonArray, type={Type}", data?.GetType().Name); return; }
        Logger.LogInformation("[Deribit] HandleUserTrades fired, count={Count}", trades.Count);
        foreach (var t in trades)
        {
            if (t is null) continue;
            Logger.LogInformation("[Deribit] Trade: {Symbol} {Side} {Size}@{Price}",
                t["instrument_name"], t["direction"], t["amount"], t["price"]);
            var fill = new Fill
            {
                FillId = t["trade_id"]?.GetValue<string>() ?? "",
                OrderId = t["order_id"]?.GetValue<string>() ?? "",
                Exchange = Venue,
                Symbol = t["instrument_name"]?.GetValue<string>() ?? "",
                Side = t["direction"]?.GetValue<string>() == "buy" ? OrderSide.Buy : OrderSide.Sell,
                FillPrice = t["price"]?.GetValue<decimal?>() ?? 0,
                FillSize = t["amount"]?.GetValue<decimal?>() ?? 0,
                FillTs = t["timestamp"]?.GetValue<long?>() ?? receivedTs,
                Commission = t["fee"]?.GetValue<decimal?>() ?? 0,
                CommissionAsset = t["fee_currency"]?.GetValue<string>() ?? "",
            };
            _ = Hub.Clients.All.SendAsync("FillUpdate", fill);
        }
    }

    private void HandleUserOrders(JsonNode? data, long receivedTs)
    {
        var raw = data?.ToJsonString() ?? "null";
        Logger.LogInformation("[Deribit] UserOrders raw: {Raw}", raw[..Math.Min(500, raw.Length)]);
        if (data is not JsonArray orders) { Logger.LogWarning("[Deribit] UserOrders data is NOT JsonArray, type={Type}", data?.GetType().Name); return; }
        Logger.LogInformation("[Deribit] HandleUserOrders fired, count={Count}", orders.Count);
        foreach (var o in orders)
        {
            if (o is null) continue;
            var stateStr = o["order_state"]?.GetValue<string>() ?? "";
            var state = stateStr switch
            {
                "filled" => OrderState.Filled,
                "cancelled" => OrderState.Cancelled,
                "rejected" => OrderState.Rejected,
                _ => OrderState.Open,
            };
            var qty = o["amount"]?.GetValue<decimal?>() ?? 0;
            var filled = o["filled_amount"]?.GetValue<decimal?>() ?? 0;

            var order = new Order
            {
                OrderId = o["order_id"]?.GetValue<string>() ?? "",
                Exchange = Venue,
                Symbol = o["instrument_name"]?.GetValue<string>() ?? "",
                Side = o["direction"]?.GetValue<string>() == "buy" ? OrderSide.Buy : OrderSide.Sell,
                OrderType = OrderType.Limit,
                Quantity = qty,
                FilledQuantity = filled,
                RemainingQuantity = qty - filled,
                LimitPrice = o["price"]?.GetValue<decimal?>(),
                AvgFillPrice = o["average_price"]?.GetValue<decimal?>(),
                State = state,
                TimeInForce = TimeInForce.Gtc,
                UpdatedAt = o["last_update_timestamp"]?.GetValue<long?>() ?? receivedTs,
                CreatedAt = o["creation_timestamp"]?.GetValue<long?>() ?? receivedTs,
            };
            _ = Hub.Clients.All.SendAsync("OrderUpdate", order);
        }
    }

    private void HandleUserPortfolio(JsonNode? data, long receivedTs)
    {
        if (data is null) return;
        var currency = data["currency"]?.GetValue<string>()?.ToUpperInvariant() ?? "";
        var balance = new Balance
        {
            Exchange = Venue,
            Currency = currency,
            Available = data["available_funds"]?.GetValue<decimal?>() ?? 0,
            Total = data["balance"]?.GetValue<decimal?>() ?? 0,
            UnrealisedPnl = data["futures_session_upl"]?.GetValue<decimal?>() ?? 0,
            Timestamp = receivedTs,
        };
        CacheAndPushBalance(balance);
    }

    private async Task FetchInitialPositionsAsync()
    {
        Logger.LogInformation("[Deribit] FetchInitialPositions called");
        foreach (var kind in new[] { "future", "option" })
        {
            try
            {
                var result = await RpcAsync("private/get_positions", new { currency = "any", kind });
                if (result is not JsonArray positions) { Logger.LogInformation("[Deribit] FetchInitialPositions {Kind}: no array result", kind); continue; }
                Logger.LogInformation("[Deribit] FetchInitialPositions {Kind}: {Count} positions", kind, positions.Count);

                foreach (var p in positions)
                {
                    if (p is null) continue;
                    var sizeCurrency = p["size_currency"]?.GetValue<decimal?>() ?? 0;
                    var size = p["size"]?.GetValue<decimal?>() ?? 0;
                    var rawSize = sizeCurrency != 0 ? sizeCurrency : size;
                    if (rawSize == 0) continue;

                    var direction = p["direction"]?.GetValue<string>() ?? "";
                    var positionSide = direction == "buy" ? "LONG" : "SHORT";
                    var instr = p["instrument_name"]?.GetValue<string>() ?? "";

                    var position = new Position
                    {
                        Exchange = Venue,
                        Symbol = instr,
                        Side = positionSide,
                        Size = Math.Abs(rawSize),
                        SizeUnit = instr.Split('-')[0],
                        AvgEntryPrice = p["average_price"]?.GetValue<decimal?>() ?? 0,
                        MarkPrice = p["mark_price"]?.GetValue<decimal?>() ?? 0,
                        UnrealisedPnl = p["floating_profit_loss"]?.GetValue<decimal?>() ?? 0,
                        LiquidationPrice = p["estimated_liquidation_price"]?.GetValue<decimal?>() ?? 0,
                        Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    };
                    CacheAndPushPosition(position);
                    Logger.LogInformation("[Deribit] Initial position: {Symbol} {Side} {Size}", instr, positionSide, rawSize);
                }
            }
            catch (Exception ex)
            {
                Logger.LogError(ex, "[Deribit] Position fetch ({Kind}) failed", kind);
            }
        }
    }

    // ── RPC ───────────────────────────────────────────────────────────────────

    private async Task<JsonNode?> RpcAsync(string method, object? paramsObj = null, string? bearerToken = null)
    {
        var id = Interlocked.Increment(ref _reqId);
        var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;

        if (bearerToken is not null)
        {
            // For REST-based private calls use HTTP
            using var http = new HttpClient();
            http.DefaultRequestHeaders.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", bearerToken);
            var r = await http.GetAsync($"{RestBase}/{method}?{BuildQueryString(paramsObj)}");
            var j = await r.Content.ReadAsStringAsync();
            var node = JsonNode.Parse(j);
            _pending.TryRemove(id, out _);
            if (node?["error"] is not null)
                throw new Exception(node["error"]!["message"]?.GetValue<string>() ?? "API error");
            return node?["result"];
        }

        var msg = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id,
            method,
            @params = paramsObj ?? new { }
        });

        var bytes = Encoding.UTF8.GetBytes(msg);
        await _ws!.SendAsync(bytes, WebSocketMessageType.Text, true, _cts.Token);

        using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        timeoutCts.Token.Register(() => tcs.TrySetException(new TimeoutException($"RPC timeout: {method}")));

        return await tcs.Task;
    }

    private async Task<string> AuthenticateAsync(ExchangeCredentials credentials)
    {
        var clientId = credentials.Fields.GetValueOrDefault("clientId") ?? "";
        var clientSecret = credentials.Fields.GetValueOrDefault("clientSecret") ?? "";
        var baseUrl = _testnet ? "https://test.deribit.com/api/v2" : "https://www.deribit.com/api/v2";
        using var http = new HttpClient();
        var r = await http.GetAsync($"{baseUrl}/public/auth?client_id={Uri.EscapeDataString(clientId)}&client_secret={Uri.EscapeDataString(clientSecret)}&grant_type=client_credentials");
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync());
        if (j?["error"] is not null) throw new Exception(j["error"]!["message"]?.GetValue<string>());
        return j?["result"]?["access_token"]?.GetValue<string>() ?? throw new Exception("No access token");
    }

    private static string BuildQueryString(object? obj)
    {
        if (obj is null) return "";
        var json = JsonSerializer.Serialize(obj);
        var dict = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json);
        if (dict is null) return "";
        return string.Join("&", dict.Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value.ToString())}"));
    }


    private static string MapSymbol(string symbol)
    {
        return symbol switch
        {
            "BTC-PERP" => "BTC-PERPETUAL",
            "ETH-PERP" => "ETH-PERPETUAL",
            "SOL-PERP" => "SOL-PERPETUAL",
            "XRP-PERP" => "XRP-PERPETUAL",
            _ when symbol.EndsWith("-PERP") => symbol.Replace("-PERP", "-PERPETUAL"),
            _ => symbol,
        };
    }

    private static readonly string[] Currencies = ["BTC", "ETH", "USDC", "SOL", "USDT"];

    private static readonly Dictionary<string, string[]> CommonPerps = new()
    {
        ["BTC"] = ["BTC-PERPETUAL"],
        ["ETH"] = ["ETH-PERPETUAL"],
        ["USDC"] = ["BTC_USDC-PERPETUAL", "ETH_USDC-PERPETUAL", "SOL_USDC-PERPETUAL", "XRP_USDC-PERPETUAL"],
        ["SOL"] = ["SOL_USDC-PERPETUAL"],
        ["USDT"] = [],
    };

    private static object MapOrder(JsonNode? o) => new
    {
        id = o?["order_id"]?.GetValue<string>() ?? "",
        exchange = "DERIBIT",
        timestamp = o?["creation_timestamp"]?.GetValue<long>() ?? 0,
        instrument = o?["instrument_name"]?.GetValue<string>() ?? "",
        type = o?["order_type"]?.GetValue<string>()?.ToUpper() ?? "LIMIT",
        side = o?["direction"]?.GetValue<string>()?.ToUpper() ?? "",
        amount = o?["amount"]?.GetValue<decimal>() ?? 0,
        filled = o?["filled_amount"]?.GetValue<decimal>() ?? 0,
        price = o?["price"]?.GetValue<decimal>() ?? 0,
        status = o?["order_state"]?.GetValue<string>() ?? "",
    };

    private async Task<JsonArray?> DeribitRestGetAsync(HttpClient http, string token, string method, string qs)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, $"{RestBase}/{method}?{qs}");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        var r = await http.SendAsync(req);
        var j = JsonNode.Parse(await r.Content.ReadAsStringAsync());
        return j?["result"] as JsonArray;
    }

    public async Task<List<object>> FetchOrderHistoryAsync(ExchangeCredentials creds, DateTime from, DateTime to)
    {
        var token = await AuthenticateAsync(creds);
        using var http = new HttpClient();
        var startTs = new DateTimeOffset(from).ToUnixTimeMilliseconds();
        var endTs = new DateTimeOffset(to).ToUnixTimeMilliseconds();
        var results = new Dictionary<string, object>();

        foreach (var currency in Currencies)
        {
            // 1. Fetch by currency first
            var byCurrencyArr = await DeribitRestGetAsync(http, token, "private/get_order_history_by_currency",
                $"currency={currency}&kind=any&start_timestamp={startTs}&end_timestamp={endTs}&count=200&include_old=true");

            var instruments = new HashSet<string>();
            if (byCurrencyArr != null)
            {
                foreach (var o in byCurrencyArr)
                {
                    var id = o?["order_id"]?.GetValue<string>() ?? "";
                    var instr = o?["instrument_name"]?.GetValue<string>() ?? "";
                    if (!string.IsNullOrEmpty(id)) results[id] = MapOrder(o);
                    if (!string.IsNullOrEmpty(instr)) instruments.Add(instr);
                }
            }

            // 2. Get instruments from positions
            var posArr = await DeribitRestGetAsync(http, token, "private/get_positions",
                $"currency={currency}&kind=any");
            if (posArr != null)
                foreach (var p in posArr)
                {
                    var instr = p?["instrument_name"]?.GetValue<string>();
                    if (!string.IsNullOrEmpty(instr)) instruments.Add(instr);
                }

            // 3. Add common perps
            if (CommonPerps.TryGetValue(currency, out var perps))
                foreach (var p in perps) instruments.Add(p);

            // 4. Fetch by instrument for additional coverage
            foreach (var instrument in instruments)
            {
                try
                {
                    var byInstrArr = await DeribitRestGetAsync(http, token, "private/get_order_history_by_instrument",
                        $"instrument_name={Uri.EscapeDataString(instrument)}&count=200&include_old=true&start_timestamp={startTs}&end_timestamp={endTs}");
                    if (byInstrArr != null)
                    {
                        var added = 0;
                        foreach (var o in byInstrArr)
                        {
                            var id = o?["order_id"]?.GetValue<string>() ?? "";
                            if (!string.IsNullOrEmpty(id) && !results.ContainsKey(id))
                            {
                                results[id] = MapOrder(o);
                                added++;
                            }
                        }
                        if (added > 0) Logger.LogInformation("[Deribit] +{Added} orders from {Instrument}", added, instrument);
                    }
                }
                catch { }
            }

            if (results.Count > 0)
                Logger.LogInformation("[Deribit] FetchOrderHistory {Currency}: {Total} total orders", currency, results.Count);
        }
        return results.Values.ToList();
    }

    public async Task<List<object>> FetchTradeHistoryAsync(ExchangeCredentials creds, DateTime from, DateTime to)
    {
        var token = await AuthenticateAsync(creds);
        using var http = new HttpClient();
        var startTs = new DateTimeOffset(from).ToUnixTimeMilliseconds();
        var endTs = new DateTimeOffset(to).ToUnixTimeMilliseconds();
        var all = new List<object>();

        foreach (var currency in Currencies)
        {
            var qs = $"currency={currency}&kind=any&start_timestamp={startTs}&end_timestamp={endTs}&count=200";
            var req = new HttpRequestMessage(HttpMethod.Get, $"{RestBase}/private/get_user_trades_by_currency?{qs}");
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            var r = await http.SendAsync(req);
            var rawBody = await r.Content.ReadAsStringAsync();
            var j = JsonNode.Parse(rawBody);
            var trades = j?["result"]?["trades"] as JsonArray ?? [];
            Logger.LogInformation("[Deribit] FetchTradeHistory {Currency}: {Count} trades", currency, trades.Count);
            all.AddRange(trades.Select(t => (object)new
            {
                id = t?["trade_id"]?.GetValue<string>() ?? "",
                exchange = "DERIBIT",
                timestamp = t?["timestamp"]?.GetValue<long>() ?? 0,
                instrument = t?["instrument_name"]?.GetValue<string>() ?? "",
                side = t?["direction"]?.GetValue<string>()?.ToUpper() ?? "",
                amount = t?["amount"]?.GetValue<decimal>() ?? 0,
                price = t?["price"]?.GetValue<decimal>() ?? 0,
                fee = t?["fee"]?.GetValue<decimal>() ?? 0,
                orderId = t?["order_id"]?.GetValue<string>() ?? "",
            }));
        }
        return all;
    }

    private static string MapTif(string tif) => tif.ToUpper() switch
    {
        "GTC" => "good_til_cancelled",
        "IOC" => "immediate_or_cancel",
        "FOK" => "fill_or_kill",
        _ => "immediate_or_cancel",
    };
}
