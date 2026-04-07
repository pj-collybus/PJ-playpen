using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using System.Text.Json.Nodes;
using Collybus.Api.Adapters;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/options")]
public class OptionsController(DeribitAdapter deribit) : ControllerBase
{
    private static readonly HttpClient _http = new();
    private static readonly Dictionary<string, (DateTime cachedAt, object data)> _cache = new();
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (DateTime ts, object resp)> _responseCache = new();
    private const int CacheTtlSeconds = 5;
    private const int ResponseCacheTtlSeconds = 8;
    private const string DeribitUrl = "https://test.deribit.com/api/v2";

    [HttpGet("matrix")]
    public async Task<IActionResult> GetMatrix(
        [FromQuery] string instrument = "BTC_USDC",
        [FromQuery] string type = "calls",
        [FromQuery] double? minStrike = null,
        [FromQuery] double? maxStrike = null,
        [FromQuery] string? fromExpiry = null,
        [FromQuery] string? toExpiry = null,
        [FromQuery] bool atmOnly = false,
        [FromQuery] string exchange = "Deribit")
    {
        var cacheKey = $"{exchange}:{instrument}:{type}:{minStrike}:{maxStrike}:{fromExpiry}:{toExpiry}:{atmOnly}";
        if (_responseCache.TryGetValue(cacheKey, out var cached) && (DateTime.UtcNow - cached.ts).TotalSeconds < ResponseCacheTtlSeconds)
        {
            Console.WriteLine($"[options] cache hit for {cacheKey}");
            return Ok(cached.resp);
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();
        Console.WriteLine($"[options] starting matrix fetch for {instrument} type={type} atm={atmOnly} toExpiry={toExpiry}");
        try
        {
            // Map instrument to Deribit currency
            var currency = instrument switch
            {
                "BTC" or "BTC_USDC" => "BTC",
                "ETH" or "ETH_USDC" => "ETH",
                "SOL_USDC" => "SOL",
                "XRP_USDC" => "XRP",
                _ => "BTC"
            };
            var isLinear = instrument.Contains("USDC");
            var kind = isLinear ? "option" : "option";

            // Get index price
            var indexResp = await CachedGet($"{DeribitUrl}/public/get_index_price?index_name={currency.ToLower()}_usd");
            var indexPrice = indexResp?["result"]?["index_price"]?.GetValue<double>() ?? 0;

            // Get all option instruments for this currency
            var instrResp = await CachedGet($"{DeribitUrl}/public/get_instruments?currency={currency}&kind={kind}&expired=false");
            var instruments = instrResp?["result"]?.AsArray() ?? new JsonArray();

            // Filter instruments
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var fromTs = ParseExpiry(fromExpiry, now);
            var toTs = ParseExpiry(toExpiry, now);

            // Try linear (USDC) first, fall back to inverse if none found
            var tryLinear = isLinear;
            var filtered = new List<JsonNode>();
            for (var attempt = 0; attempt < 2; attempt++)
            {
                filtered.Clear();
                foreach (var inst in instruments)
                {
                    if (inst == null) continue;
                    var name = inst["instrument_name"]?.GetValue<string>() ?? "";
                    if (tryLinear && !name.Contains("_USDC")) continue;
                    if (!tryLinear && name.Contains("_USDC")) continue;

                var optionType = inst["option_type"]?.GetValue<string>() ?? "";
                if (type == "calls" && optionType != "call") continue;
                if (type == "puts" && optionType != "put") continue;

                var strike = inst["strike"]?.GetValue<double>() ?? 0;
                if (minStrike.HasValue && strike < minStrike.Value) continue;
                if (maxStrike.HasValue && strike > maxStrike.Value) continue;

                var expiryTs = inst["expiration_timestamp"]?.GetValue<long>() ?? 0;
                if (fromTs > 0 && expiryTs < fromTs) continue;
                if (toTs > 0 && expiryTs > toTs) continue;

                // ATM filter: within 10% of index
                if (atmOnly && indexPrice > 0)
                {
                    if (strike < indexPrice * 0.9 || strike > indexPrice * 1.1) continue;
                }

                    filtered.Add(inst);
                }
                if (filtered.Count > 0 || !tryLinear) break;
                tryLinear = false; // fallback to inverse
            }

            Console.WriteLine($"[options] got {filtered.Count} filtered instruments in {sw.ElapsedMilliseconds}ms");

            // Bulk fetch ALL option summaries for this currency in ONE call
            var summaryResp = await CachedGet($"{DeribitUrl}/public/get_book_summary_by_currency?currency={currency}&kind=option");
            var summaries = summaryResp?["result"]?.AsArray() ?? new JsonArray();
            Console.WriteLine($"[options] got {summaries.Count} summaries in {sw.ElapsedMilliseconds}ms");

            // Index summaries by instrument_name for O(1) lookup
            var summaryMap = new Dictionary<string, JsonNode>(StringComparer.OrdinalIgnoreCase);
            foreach (var s in summaries)
            {
                var sName = s?["instrument_name"]?.GetValue<string>();
                if (sName != null) summaryMap[sName] = s!;
            }

            // Build cells from filtered instruments + summary data
            var cells = new Dictionary<string, Dictionary<string, object>>();
            var strikes = new SortedSet<double>();
            var expiries = new SortedSet<string>();

            foreach (var inst in filtered)
            {
                var name = inst!["instrument_name"]?.GetValue<string>() ?? "";
                var strike = inst["strike"]?.GetValue<double>() ?? 0;
                var expiryTs = inst["expiration_timestamp"]?.GetValue<long>() ?? 0;
                var expiryStr = DateTimeOffset.FromUnixTimeMilliseconds(expiryTs).UtcDateTime.ToString("yyyy-MM-dd");
                var optionType = inst["option_type"]?.GetValue<string>() ?? "";
                var dte = (int)Math.Ceiling((expiryTs - now) / 86400000.0);

                strikes.Add(strike);
                expiries.Add(expiryStr);

                if (!summaryMap.TryGetValue(name, out var sm)) continue;

                var bid = sm["bid_price"]?.GetValue<double?>() ?? 0;
                var ask = sm["ask_price"]?.GetValue<double?>() ?? 0;
                var mark = sm["mark_price"]?.GetValue<double?>() ?? 0;
                var markIv = sm["mark_iv"]?.GetValue<double?>() ?? 0;
                var bidIv = sm["bid_iv"]?.GetValue<double?>() ?? 0;
                var askIv = sm["ask_iv"]?.GetValue<double?>() ?? 0;
                var volume = sm["volume"]?.GetValue<double?>() ?? 0;
                var oi = sm["open_interest"]?.GetValue<double?>() ?? 0;

                var strikeKey = strike.ToString("F0");
                if (!cells.ContainsKey(strikeKey))
                    cells[strikeKey] = new Dictionary<string, object>();

                cells[strikeKey][expiryStr] = new
                {
                    instrument = name,
                    optionType,
                    strike,
                    expiry = expiryStr,
                    dte,
                    bid,
                    ask,
                    mark,
                    markIv,
                    bidIv,
                    askIv,
                    volume,
                    openInterest = oi,
                };
            }

            Console.WriteLine($"[options] built {cells.Count} strike rows in {sw.ElapsedMilliseconds}ms");
            var atmStrike = indexPrice > 0 ? strikes.OrderBy(s => Math.Abs(s - indexPrice)).FirstOrDefault() : 0;

            var response = new
            {
                strikes = strikes.ToList(),
                expiries = expiries.ToList(),
                cells,
                indexPrice,
                atmStrike,
                instrument,
                type,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            _responseCache[cacheKey] = (DateTime.UtcNow, response);
            Console.WriteLine($"[options] total request time: {sw.ElapsedMilliseconds}ms");
            return Ok(response);
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpGet("expiries")]
    public async Task<IActionResult> GetExpiries(
        [FromQuery] string instrument = "BTC_USDC",
        [FromQuery] string type = "calls")
    {
        try
        {
            var currency = instrument switch
            {
                "BTC" or "BTC_USDC" => "BTC",
                "ETH" or "ETH_USDC" => "ETH",
                "SOL_USDC" => "SOL",
                "XRP_USDC" => "XRP",
                _ => "BTC"
            };
            var isLinear = instrument.Contains("USDC");

            var instrResp = await CachedGet($"{DeribitUrl}/public/get_instruments?currency={currency}&kind=option&expired=false");
            var instruments = instrResp?["result"]?.AsArray() ?? new JsonArray();

            var expiries = new SortedSet<string>();
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            // Try linear (USDC) first, fall back to inverse if none found
            var tryLinear = isLinear;
            for (var attempt = 0; attempt < 2; attempt++)
            {
                expiries.Clear();
                foreach (var inst in instruments)
                {
                    if (inst == null) continue;
                    var name = inst["instrument_name"]?.GetValue<string>() ?? "";
                    if (tryLinear && !name.Contains("_USDC")) continue;
                    if (!tryLinear && name.Contains("_USDC")) continue;

                    var optionType = inst["option_type"]?.GetValue<string>() ?? "";
                    if (type == "calls" && optionType != "call") continue;
                    if (type == "puts" && optionType != "put") continue;

                    var expiryTs = inst["expiration_timestamp"]?.GetValue<long>() ?? 0;
                    if (expiryTs <= now) continue;
                    expiries.Add(DateTimeOffset.FromUnixTimeMilliseconds(expiryTs).UtcDateTime.ToString("yyyy-MM-dd"));
                }
                if (expiries.Count > 0 || !tryLinear) break;
                tryLinear = false; // fallback to inverse
            }

            // Index price for ATM
            var indexResp = await CachedGet($"{DeribitUrl}/public/get_index_price?index_name={currency.ToLower()}_usd");
            var indexPrice = indexResp?["result"]?["index_price"]?.GetValue<double>() ?? 0;

            return Ok(new { expiries = expiries.ToList(), indexPrice, instrument, type });
        }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpPost("subscribe")]
    public async Task<IActionResult> SubscribeOptionsSummary([FromBody] SubscribeRequest req)
    {
        try
        {
            var currency = MapCurrency(req.Instrument ?? "BTC");
            await deribit.SubscribeOptionsSummaryAsync(currency);
            return Ok(new { ok = true, currency });
        }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    [HttpPost("unsubscribe")]
    public async Task<IActionResult> UnsubscribeOptionsSummary([FromBody] SubscribeRequest req)
    {
        try
        {
            var currency = MapCurrency(req.Instrument ?? "BTC");
            await deribit.UnsubscribeOptionsSummaryAsync(currency);
            return Ok(new { ok = true });
        }
        catch (Exception ex) { return BadRequest(new { error = ex.Message }); }
    }

    public record SubscribeRequest { public string? Instrument { get; init; } }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (DateTime ts, object data)> _greeksCache = new();

    [HttpPost("greeks")]
    public async Task<IActionResult> GetGreeks([FromBody] string[] instrumentNames)
    {
        var limited = instrumentNames.Take(50).ToArray();
        var results = new Dictionary<string, object>();

        var tasks = limited.Select(async name =>
        {
            // Check cache first (5s TTL)
            if (_greeksCache.TryGetValue(name, out var cached) && (DateTime.UtcNow - cached.ts).TotalSeconds < 5)
                return (name, cached.data);

            try
            {
                var resp = await CachedGet($"{DeribitUrl}/public/ticker?instrument_name={name}");
                var r = resp?["result"];
                if (r == null) return (name, (object?)null);
                var greeks = new
                {
                    delta = r["greeks"]?["delta"]?.GetValue<double?>(),
                    gamma = r["greeks"]?["gamma"]?.GetValue<double?>(),
                    vega = r["greeks"]?["vega"]?.GetValue<double?>(),
                    theta = r["greeks"]?["theta"]?.GetValue<double?>(),
                    rho = r["greeks"]?["rho"]?.GetValue<double?>(),
                    bidIv = r["bid_iv"]?.GetValue<double?>(),
                    askIv = r["ask_iv"]?.GetValue<double?>(),
                    markIv = r["mark_iv"]?.GetValue<double?>(),
                    openInterest = r["open_interest"]?.GetValue<double?>(),
                    volume = r["stats"]?["volume"]?.GetValue<double?>(),
                };
                _greeksCache[name] = (DateTime.UtcNow, greeks);
                return (name, (object?)greeks);
            }
            catch { return (name, (object?)null); }
        });

        var all = await Task.WhenAll(tasks);
        foreach (var (name, data) in all)
            if (data != null) results[name] = data;

        return Ok(results);
    }

    private static string MapCurrency(string instrument) => instrument switch
    {
        "BTC" or "BTC_USDC" => "BTC",
        "ETH" or "ETH_USDC" => "ETH",
        "SOL_USDC" => "SOL",
        "XRP_USDC" => "XRP",
        _ => "BTC"
    };

    private async Task<JsonNode?> CachedGet(string url)
    {
        if (_cache.TryGetValue(url, out var cached) && (DateTime.UtcNow - cached.cachedAt).TotalSeconds < CacheTtlSeconds)
            return cached.data as JsonNode;

        var resp = await _http.GetStringAsync(url);
        var node = JsonNode.Parse(resp);
        _cache[url] = (DateTime.UtcNow, node!);
        return node;
    }

    private static long ParseExpiry(string? str, long now)
    {
        if (string.IsNullOrEmpty(str)) return 0;
        if (str.EndsWith("d")) return now + long.Parse(str[..^1]) * 86400000L;
        if (str.EndsWith("w")) return now + long.Parse(str[..^1]) * 7 * 86400000L;
        if (str.EndsWith("m")) return now + long.Parse(str[..^1]) * 30 * 86400000L;
        if (str.EndsWith("y")) return now + long.Parse(str[..^1]) * 365 * 86400000L;
        return 0;
    }
}
