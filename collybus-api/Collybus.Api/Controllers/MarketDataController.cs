using System.Globalization;
using System.Text.Json;
using Collybus.Api.Adapters;
using Microsoft.AspNetCore.Mvc;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/marketdata")]
public class MarketDataController : ControllerBase
{
    private readonly DeribitAdapter _deribit;
    private readonly BitmexAdapter _bitmex;
    private readonly ILogger<MarketDataController> _logger;

    public MarketDataController(DeribitAdapter deribit, BitmexAdapter bitmex, ILogger<MarketDataController> logger)
    {
        _deribit = deribit;
        _bitmex = bitmex;
        _logger = logger;
    }

    [HttpPost("subscribe")]
    public async Task<IActionResult> Subscribe([FromBody] SubscribeRequest request)
    {
        var exchange = request.Exchange?.ToUpperInvariant() ?? "DERIBIT";
        _logger.LogInformation("[Subscribe] Exchange={Exchange} Symbols={Symbols}", exchange, string.Join(",", request.Symbols));
        if (exchange == "BITMEX")
        {
            await _bitmex.ConnectAsync();
            foreach (var symbol in request.Symbols)
                await _bitmex.SubscribeAsync(symbol);
        }
        else
        {
            await _deribit.ConnectAsync();
            foreach (var symbol in request.Symbols)
                await _deribit.SubscribeAsync(symbol);
        }
        return Ok(new { ok = true });
    }

    [HttpPost("unsubscribe")]
    public async Task<IActionResult> Unsubscribe([FromBody] SubscribeRequest request)
    {
        var exchange = request.Exchange?.ToUpperInvariant() ?? "DERIBIT";
        _logger.LogInformation("[Unsubscribe] {Exchange} {Symbols}", exchange, string.Join(",", request.Symbols));
        if (exchange == "BITMEX")
        {
            foreach (var symbol in request.Symbols)
                await _bitmex.UnsubscribeAsync(symbol);
        }
        else
        {
            foreach (var symbol in request.Symbols)
                await _deribit.UnsubscribeAsync(symbol);
        }
        return Ok(new { ok = true });
    }

    [HttpPost("connect")]
    public async Task<IActionResult> Connect([FromBody] ConnectRequest? request = null)
    {
        var exchange = request?.Exchange?.ToUpperInvariant() ?? "DERIBIT";
        _logger.LogInformation("[Connect] Exchange={Exchange}", exchange);
        if (exchange == "BITMEX")
            await _bitmex.ConnectAsync();
        else
            await _deribit.ConnectAsync();
        return Ok(new { ok = true });
    }

    private static readonly Dictionary<string, (List<object> Data, DateTime Expires)> _instrumentCache = new();

    [HttpGet("contract-specs")]
    public async Task<IActionResult> GetAllContractSpecs()
    {
        var allExchanges = new[] { "DERIBIT", "BITMEX", "BINANCE", "BYBIT", "OKX", "KRAKEN" };
        var results = new List<object>();
        foreach (var ex in allExchanges)
        {
            try
            {
                if (_instrumentCache.TryGetValue(ex, out var cached) && cached.Expires > DateTime.UtcNow)
                { results.AddRange(cached.Data); continue; }
                using var http = new HttpClient();
                http.Timeout = TimeSpan.FromSeconds(30);
                var data = ex switch {
                    "DERIBIT" => await FetchDeribitInstruments(http),
                    "BITMEX" => await FetchBitmexInstruments(http),
                    "BINANCE" => await FetchBinanceInstruments(http),
                    "BYBIT" => await FetchBybitInstruments(http),
                    "OKX" => await FetchOkxInstruments(http),
                    "KRAKEN" => await FetchKrakenInstruments(http),
                    _ => new List<object>()
                };
                _instrumentCache[ex] = (data, DateTime.UtcNow.AddMinutes(5));
                results.AddRange(data);
            }
            catch (Exception e) { _logger.LogWarning("[ContractSpecs] Failed {Exchange}: {Err}", ex, e.Message); }
        }
        return Ok(results);
    }

    [HttpGet("instruments/{exchange}")]
    public async Task<IActionResult> GetInstruments(string exchange)
    {
        var exchangeUpper = exchange.ToUpperInvariant();

        if (_instrumentCache.TryGetValue(exchangeUpper, out var cached) && cached.Expires > DateTime.UtcNow)
        {
            _logger.LogInformation("[Instruments] {Exchange}: returning {Count} from cache", exchangeUpper, cached.Data.Count);
            return Ok(cached.Data);
        }

        var results = new List<object>();
        using var http = new HttpClient();
        http.Timeout = TimeSpan.FromSeconds(30);

        try
        {
            switch (exchangeUpper)
            {
                case "DERIBIT":
                    results = await FetchDeribitInstruments(http);
                    break;
                case "BITMEX":
                    results = await FetchBitmexInstruments(http);
                    break;
                case "BINANCE":
                    results = await FetchBinanceInstruments(http);
                    break;
                case "BYBIT":
                    results = await FetchBybitInstruments(http);
                    break;
                case "OKX":
                    results = await FetchOkxInstruments(http);
                    break;
                case "KRAKEN":
                    results = await FetchKrakenInstruments(http);
                    break;
                default:
                    _logger.LogWarning("[Instruments] No handler for exchange: {Exchange}", exchange);
                    return Ok(new List<object>());
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Instruments] Failed to fetch instruments for {Exchange}", exchange);
            return Ok(new List<object>());
        }

        // Sort: BTC perps first, other perps, BTC futures, everything else
        var sorted = results
            .OrderBy(r => {
                string sym = ((dynamic)r).symbol.ToString();
                bool isPerp = (bool)((dynamic)r).isPerp;
                bool isBtc = sym.StartsWith("BTC") || sym.StartsWith("XBT");
                if (isBtc && isPerp) return 0;
                if (isPerp) return 1;
                if (isBtc) return 2;
                return 3;
            })
            .ThenBy(r => ((dynamic)r).symbol.ToString())
            .ToList();

        _instrumentCache[exchangeUpper] = (sorted, DateTime.UtcNow.AddMinutes(5));
        _logger.LogInformation("[Instruments] {Exchange}: {Count} instruments (cached for 5min)", exchangeUpper, sorted.Count);
        return Ok(sorted);
    }

    private async Task<List<object>> FetchDeribitInstruments(HttpClient http)
    {
        var results = new List<object>();
        var currencies = new List<string>();
        try
        {
            var r = await http.GetAsync("https://test.deribit.com/api/v2/public/get_currencies");
            var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
            if (j.RootElement.TryGetProperty("result", out var arr))
                foreach (var c in arr.EnumerateArray())
                    if (c.TryGetProperty("currency", out var ccy) && !string.IsNullOrEmpty(ccy.GetString()))
                        currencies.Add(ccy.GetString()!);
        }
        catch { currencies = ["BTC", "ETH", "SOL", "XRP", "USDC"]; }

        _logger.LogInformation("[Instruments] Deribit: {Count} currencies", currencies.Count);

        foreach (var ccy in currencies)
        {
            foreach (var kind in new[] { "future", "spot" })
            {
                try
                {
                    var url = $"https://test.deribit.com/api/v2/public/get_instruments?currency={ccy}&kind={kind}&expired=false";
                    var r = await http.GetAsync(url);
                    var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
                    if (!j.RootElement.TryGetProperty("result", out var arr)) continue;
                    foreach (var item in arr.EnumerateArray())
                    {
                        var name = item.GetProperty("instrument_name").GetString() ?? "";
                        var kindStr = item.GetProperty("kind").GetString() ?? "";
                        var isPerp = name.Contains("PERPETUAL");
                        var baseCcy = item.TryGetProperty("base_currency", out var bc) ? bc.GetString() ?? "" : ccy;
                        var quoteCcy = item.TryGetProperty("quote_currency", out var qc) ? qc.GetString() ?? "USD" : "USD";
                        var settleCcy = item.TryGetProperty("settlement_currency", out var sc) ? sc.GetString() ?? "USD" : "USD";
                        var isInverse = settleCcy == baseCcy && kindStr != "spot";
                        decimal tickSize = 0, lotSize = 0, minOrderSize = 0;
                        if (item.TryGetProperty("tick_size", out var ts)) tickSize = ts.GetDecimal();
                        if (item.TryGetProperty("contract_size", out var cs)) lotSize = cs.GetDecimal();
                        if (item.TryGetProperty("min_trade_amount", out var mta)) minOrderSize = mta.GetDecimal();
                        results.Add(new {
                            symbol = name, exchange = "DERIBIT",
                            tickSize, lotSize, minOrderSize,
                            contractType = kindStr == "spot" ? "SPOT" : isInverse ? "INVERSE" : "LINEAR",
                            baseCurrency = baseCcy, quoteCurrency = quoteCcy, settleCurrency = settleCcy,
                            isPerp, isInverse, kind = kindStr,
                            sizeUnit = isInverse ? "quote" : "base",
                        });
                    }
                }
                catch (Exception ex) { _logger.LogWarning("[Instruments] Deribit {Ccy}/{Kind}: {Err}", ccy, kind, ex.Message); }
            }
        }

        // Fetch options for BTC and ETH only
        foreach (var ccy in new[] { "BTC", "ETH" })
        {
            try
            {
                var url = $"https://test.deribit.com/api/v2/public/get_instruments?currency={ccy}&kind=option&expired=false";
                var r = await http.GetAsync(url);
                var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
                if (!j.RootElement.TryGetProperty("result", out var arr)) continue;
                foreach (var item in arr.EnumerateArray())
                {
                    var name = item.GetProperty("instrument_name").GetString() ?? "";
                    var baseCcy = item.TryGetProperty("base_currency", out var bc) ? bc.GetString() ?? "" : ccy;
                    decimal tickSize = 0, lotSize = 0;
                    if (item.TryGetProperty("tick_size", out var ts)) tickSize = ts.GetDecimal();
                    if (item.TryGetProperty("contract_size", out var cs)) lotSize = cs.GetDecimal();
                    results.Add(new {
                        symbol = name, exchange = "DERIBIT",
                        tickSize, lotSize, minOrderSize = 0m,
                        contractType = "OPTION",
                        baseCurrency = baseCcy, quoteCurrency = "USD", settleCurrency = baseCcy,
                        isPerp = false, isInverse = false, kind = "option", sizeUnit = "contracts",
                    });
                }
            }
            catch (Exception ex) { _logger.LogWarning("[Instruments] Deribit options {Ccy}: {Err}", ccy, ex.Message); }
        }

        return results;
    }

    private async Task<List<object>> FetchBitmexInstruments(HttpClient http)
    {
        var results = new List<object>();
        var start = 0;
        const int count = 500;
        while (true)
        {
            var url = $"https://testnet.bitmex.com/api/v1/instrument?count={count}&start={start}&reverse=false";
            var r = await http.GetAsync(url);
            var arr = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
            var items = arr.RootElement.EnumerateArray().ToList();
            if (items.Count == 0) break;
            foreach (var item in items)
            {
                var symbol = item.TryGetProperty("symbol", out var sym) ? sym.GetString() ?? "" : "";
                var state = item.TryGetProperty("state", out var st) ? st.GetString() ?? "" : "";
                if (state == "Closed" || state == "Unlisted") continue;
                var typStr = item.TryGetProperty("typ", out var t) ? t.GetString() ?? "" : "";
                var baseCcy = item.TryGetProperty("rootSymbol", out var root) ? root.GetString() ?? "" : "";
                var quoteCcy = item.TryGetProperty("quoteCurrency", out var qc) ? qc.GetString() ?? "USD" : "USD";
                var settleCcy = item.TryGetProperty("settlCurrency", out var sc) ? sc.GetString() ?? "" : "";
                decimal tickSize = 0;
                if (item.TryGetProperty("tickSize", out var ts) && ts.ValueKind != JsonValueKind.Null) tickSize = ts.GetDecimal();
                var rawLot = item.TryGetProperty("lotSize", out var ls) && ls.ValueKind != JsonValueKind.Null ? ls.GetDouble() : 1.0;
                var multiplier = item.TryGetProperty("underlyingToPositionMultiplier", out var m)
                    && m.ValueKind != JsonValueKind.Null ? m.GetDouble() : 0.0;

                string contractType, sizeUnit;
                double lotSizeBase;
                if (typStr == "IFXXXP")
                {
                    contractType = "SPOT"; sizeUnit = "base"; lotSizeBase = 1;
                }
                else if (!string.IsNullOrEmpty(settleCcy) && (settleCcy == baseCcy || settleCcy.Equals(baseCcy, StringComparison.OrdinalIgnoreCase)))
                {
                    contractType = "INVERSE"; sizeUnit = "quote"; lotSizeBase = rawLot;
                }
                else if (settleCcy.Equals(quoteCcy, StringComparison.OrdinalIgnoreCase) ||
                         settleCcy.Equals("USDT", StringComparison.OrdinalIgnoreCase) ||
                         settleCcy.Equals("USDC", StringComparison.OrdinalIgnoreCase))
                {
                    contractType = "LINEAR"; sizeUnit = "contracts";
                    lotSizeBase = multiplier != 0 ? 1.0 / multiplier : rawLot;
                }
                else
                {
                    contractType = typStr == "OCECCS" ? "OPTION" : "QUANTO";
                    sizeUnit = "contracts"; lotSizeBase = rawLot;
                }

                var isInverse = contractType == "INVERSE";
                var isPerp = !symbol.Any(char.IsDigit) || symbol.EndsWith("USD") || symbol.EndsWith("USDT") || symbol.EndsWith("USDC");
                var kind = typStr == "IFXXXP" ? "spot" : "future";

                results.Add(new {
                    symbol, exchange = "BITMEX",
                    tickSize, lotSize = (decimal)lotSizeBase, minOrderSize = (decimal)lotSizeBase,
                    contractType,
                    baseCurrency = baseCcy, quoteCurrency = quoteCcy, settleCurrency = settleCcy,
                    isPerp, isInverse, kind, sizeUnit,
                });
            }
            if (items.Count < count) break;
            start += count;
        }
        return results;
    }

    private async Task<List<object>> FetchBinanceInstruments(HttpClient http)
    {
        var results = new List<object>();
        // Spot
        try {
            var r = await http.GetAsync("https://api.binance.com/api/v3/exchangeInfo");
            var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
            if (j.RootElement.TryGetProperty("symbols", out var arr))
                foreach (var item in arr.EnumerateArray())
                {
                    if (item.TryGetProperty("status", out var st) && st.GetString() != "TRADING") continue;
                    var symbol = item.GetProperty("symbol").GetString() ?? "";
                    var base_ = item.TryGetProperty("baseAsset", out var ba) ? ba.GetString() ?? "" : "";
                    var quote = item.TryGetProperty("quoteAsset", out var qa) ? qa.GetString() ?? "" : "";
                    decimal tickSize = 0;
                    if (item.TryGetProperty("filters", out var filters))
                        foreach (var f in filters.EnumerateArray())
                            if (f.TryGetProperty("filterType", out var ft) && ft.GetString() == "PRICE_FILTER")
                                if (f.TryGetProperty("tickSize", out var ts)) decimal.TryParse(ts.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out tickSize);
                    results.Add(new {
                        symbol, exchange = "BINANCE",
                        tickSize, lotSize = 1m, minOrderSize = 0m,
                        contractType = "SPOT",
                        baseCurrency = base_, quoteCurrency = quote, settleCurrency = quote,
                        isPerp = false, isInverse = false, kind = "spot", sizeUnit = "base",
                    });
                }
        } catch (Exception ex) { _logger.LogWarning("[Instruments] Binance spot: {Err}", ex.Message); }
        // USDT Futures
        try {
            var r = await http.GetAsync("https://fapi.binance.com/fapi/v1/exchangeInfo");
            var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
            if (j.RootElement.TryGetProperty("symbols", out var arr))
                foreach (var item in arr.EnumerateArray())
                {
                    if (item.TryGetProperty("status", out var st) && st.GetString() != "TRADING") continue;
                    var symbol = item.GetProperty("symbol").GetString() ?? "";
                    var ct = item.TryGetProperty("contractType", out var ctv) ? ctv.GetString() ?? "" : "";
                    var isPerp = ct == "PERPETUAL";
                    var base_ = item.TryGetProperty("baseAsset", out var ba) ? ba.GetString() ?? "" : "";
                    var quote = item.TryGetProperty("quoteAsset", out var qa) ? qa.GetString() ?? "" : "";
                    decimal tickSize = 0;
                    if (item.TryGetProperty("filters", out var filters))
                        foreach (var f in filters.EnumerateArray())
                            if (f.TryGetProperty("filterType", out var ft) && ft.GetString() == "PRICE_FILTER")
                                if (f.TryGetProperty("tickSize", out var ts)) decimal.TryParse(ts.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out tickSize);
                    results.Add(new {
                        symbol, exchange = "BINANCE",
                        tickSize, lotSize = 1m, minOrderSize = 0m,
                        contractType = "LINEAR",
                        baseCurrency = base_, quoteCurrency = quote, settleCurrency = quote,
                        isPerp, isInverse = false, kind = "future", sizeUnit = "base",
                    });
                }
        } catch (Exception ex) { _logger.LogWarning("[Instruments] Binance futures: {Err}", ex.Message); }
        return results;
    }

    private async Task<List<object>> FetchBybitInstruments(HttpClient http)
    {
        var results = new List<object>();
        foreach (var category in new[] { "linear", "inverse", "spot" })
        {
            try {
                var url = $"https://api.bybit.com/v5/market/instruments-info?category={category}&limit=1000";
                var r = await http.GetAsync(url);
                var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
                if (!j.RootElement.TryGetProperty("result", out var result)) continue;
                if (!result.TryGetProperty("list", out var arr)) continue;
                foreach (var item in arr.EnumerateArray())
                {
                    var status = item.TryGetProperty("status", out var st) ? st.GetString() : "";
                    if (status != "Trading") continue;
                    var symbol = item.GetProperty("symbol").GetString() ?? "";
                    var base_ = item.TryGetProperty("baseCoin", out var bc) ? bc.GetString() ?? "" : "";
                    var quote = item.TryGetProperty("quoteCoin", out var qc) ? qc.GetString() ?? "" : "";
                    var isPerp = symbol.EndsWith("USDT") || symbol.EndsWith("USDC") || symbol.EndsWith("USD");
                    decimal tickSize = 0;
                    if (item.TryGetProperty("priceFilter", out var pf) && pf.TryGetProperty("tickSize", out var ts))
                        decimal.TryParse(ts.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out tickSize);
                    results.Add(new {
                        symbol, exchange = "BYBIT",
                        tickSize, lotSize = 1m, minOrderSize = 0m,
                        contractType = category == "inverse" ? "INVERSE" : category == "spot" ? "SPOT" : "LINEAR",
                        baseCurrency = base_, quoteCurrency = quote, settleCurrency = quote,
                        isPerp, isInverse = category == "inverse", kind = category == "spot" ? "spot" : "future", sizeUnit = category == "spot" ? "base" : "contracts",
                    });
                }
            } catch (Exception ex) { _logger.LogWarning("[Instruments] Bybit {Cat}: {Err}", category, ex.Message); }
        }
        return results;
    }

    private async Task<List<object>> FetchOkxInstruments(HttpClient http)
    {
        var results = new List<object>();
        foreach (var instType in new[] { "SPOT", "FUTURES", "SWAP" })
        {
            try {
                var url = $"https://www.okx.com/api/v5/public/instruments?instType={instType}";
                var r = await http.GetAsync(url);
                var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
                if (!j.RootElement.TryGetProperty("data", out var arr)) continue;
                foreach (var item in arr.EnumerateArray())
                {
                    var state = item.TryGetProperty("state", out var st) ? st.GetString() : "";
                    if (state != "live") continue;
                    var symbol = item.GetProperty("instId").GetString() ?? "";
                    var base_ = item.TryGetProperty("baseCcy", out var bc) ? bc.GetString() ?? "" : "";
                    var quote = item.TryGetProperty("quoteCcy", out var qc) ? qc.GetString() ?? "" : "";
                    var isPerp = instType == "SWAP";
                    decimal tickSize = 0;
                    if (item.TryGetProperty("tickSz", out var ts))
                        decimal.TryParse(ts.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out tickSize);
                    results.Add(new {
                        symbol, exchange = "OKX",
                        tickSize, lotSize = 1m, minOrderSize = 0m,
                        contractType = instType == "SPOT" ? "SPOT" : "LINEAR",
                        baseCurrency = base_, quoteCurrency = quote, settleCurrency = quote,
                        isPerp, isInverse = false, kind = instType == "SPOT" ? "spot" : "future", sizeUnit = instType == "SPOT" ? "base" : "contracts",
                    });
                }
            } catch (Exception ex) { _logger.LogWarning("[Instruments] OKX {Type}: {Err}", instType, ex.Message); }
        }
        return results;
    }

    private async Task<List<object>> FetchKrakenInstruments(HttpClient http)
    {
        var results = new List<object>();
        try {
            var r = await http.GetAsync("https://api.kraken.com/0/public/AssetPairs");
            var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
            if (j.RootElement.TryGetProperty("result", out var pairs))
                foreach (var pair in pairs.EnumerateObject())
                {
                    var symbol = pair.Name;
                    var base_ = pair.Value.TryGetProperty("base", out var bc) ? bc.GetString() ?? "" : "";
                    var quote = pair.Value.TryGetProperty("quote", out var qc) ? qc.GetString() ?? "" : "";
                    decimal tickSize = 0;
                    if (pair.Value.TryGetProperty("tick_size", out var ts))
                        decimal.TryParse(ts.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out tickSize);
                    results.Add(new {
                        symbol, exchange = "KRAKEN",
                        tickSize, lotSize = 1m, minOrderSize = 0m,
                        contractType = "SPOT",
                        baseCurrency = base_, quoteCurrency = quote, settleCurrency = quote,
                        isPerp = false, isInverse = false, kind = "spot", sizeUnit = "base",
                    });
                }
        } catch (Exception ex) { _logger.LogWarning("[Instruments] Kraken spot: {Err}", ex.Message); }
        return results;
    }
}

public record SubscribeRequest(string[] Symbols, string? Exchange = "DERIBIT");
public record ConnectRequest(string? Exchange = "DERIBIT");
