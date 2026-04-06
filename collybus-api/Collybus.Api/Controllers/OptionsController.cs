using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/options")]
public class OptionsController : ControllerBase
{
    private static readonly HttpClient _http = new();
    private static readonly Dictionary<string, (DateTime cachedAt, object data)> _cache = new();
    private const int CacheTtlSeconds = 5;
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
        Console.WriteLine($"[options] GET /api/options/matrix: exchange={exchange} instrument={instrument} type={type} atm={atmOnly} toExpiry={toExpiry}");
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

            // Get order books for filtered instruments (batch)
            var cells = new Dictionary<string, Dictionary<string, object>>();
            var strikes = new SortedSet<double>();
            var expiries = new SortedSet<string>();

            foreach (var inst in filtered)
            {
                var name = inst!["instrument_name"]?.GetValue<string>() ?? "";
                var strike = inst["strike"]?.GetValue<double>() ?? 0;
                var expiryTs = inst["expiration_timestamp"]?.GetValue<long>() ?? 0;
                var expiryStr = DateTimeOffset.FromUnixTimeMilliseconds(expiryTs).ToString("ddMMMyy").ToUpper();
                var optionType = inst["option_type"]?.GetValue<string>() ?? "";
                var dte = (int)Math.Ceiling((expiryTs - now) / 86400000.0);

                strikes.Add(strike);
                expiries.Add(expiryStr);

                // Get ticker for this instrument
                try
                {
                    var tickerResp = await CachedGet($"{DeribitUrl}/public/ticker?instrument_name={name}");
                    var result = tickerResp?["result"];
                    if (result == null) continue;

                    var bid = result["best_bid_price"]?.GetValue<double?>() ?? 0;
                    var ask = result["best_ask_price"]?.GetValue<double?>() ?? 0;
                    var mark = result["mark_price"]?.GetValue<double?>() ?? 0;
                    var markIv = result["mark_iv"]?.GetValue<double?>() ?? 0;
                    var bidIv = result["bid_iv"]?.GetValue<double?>() ?? 0;
                    var askIv = result["ask_iv"]?.GetValue<double?>() ?? 0;
                    var volume = result["stats"]?["volume"]?.GetValue<double?>() ?? 0;
                    var oi = result["open_interest"]?.GetValue<double?>() ?? 0;

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
                catch { /* skip failed tickers */ }
            }

            var atmStrike = indexPrice > 0 ? strikes.OrderBy(s => Math.Abs(s - indexPrice)).FirstOrDefault() : 0;

            return Ok(new
            {
                strikes = strikes.ToList(),
                expiries = expiries.ToList(),
                cells,
                indexPrice,
                atmStrike,
                instrument,
                type,
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            });
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
