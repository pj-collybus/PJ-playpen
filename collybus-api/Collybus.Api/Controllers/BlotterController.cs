using Collybus.Api.Adapters;
using Collybus.Api.Models;
using Collybus.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/blotter")]
public class BlotterController(IBlotterService blotterService, IKeyStore keyStore, DeribitAdapter deribit, BitmexAdapter bitmex, IEnumerable<IExchangeAdapter> adapters) : ControllerBase
{
    [HttpPost("snapshot")]
    public async Task<IActionResult> RequestSnapshot()
    {
        foreach (var adapter in adapters)
        {
            if (adapter is BaseExchangeAdapter baseAdapter)
                await baseAdapter.RepushCachedStateAsync();
        }
        return Ok(new { ok = true });
    }

    [HttpGet]
    public IActionResult GetSnapshot([FromQuery] string? venue)
    {
        var snap = blotterService.GetSnapshot(venue);
        return Ok(snap);
    }

    [HttpGet("positions")]
    public IActionResult GetPositions([FromQuery] string? venue)
    {
        return Ok(blotterService.GetPositions(venue));
    }

    [HttpGet("balances")]
    public IActionResult GetBalances([FromQuery] string? venue)
    {
        return Ok(blotterService.GetBalances(venue));
    }

    [HttpGet("orders")]
    public async Task<IActionResult> GetOrders([FromQuery] string exchange = "DERIBIT", [FromQuery] string period = "today")
    {
        var (from, to) = GetPeriodRange(period);
        var key = keyStore.GetKey(exchange);
        if (key == null) return Ok(Array.Empty<object>());

        var creds = new ExchangeCredentials
        {
            Exchange = key.Exchange,
            Fields = key.Fields,
            Testnet = key.Testnet,
        };

        if (exchange.Equals("DERIBIT", StringComparison.OrdinalIgnoreCase))
        {
            var orders = await deribit.FetchOrderHistoryAsync(creds, from, to);
            return Ok(orders);
        }
        if (exchange.Equals("BITMEX", StringComparison.OrdinalIgnoreCase))
        {
            var orders = await bitmex.FetchOrderHistoryAsync(creds, from, to);
            return Ok(orders);
        }
        return Ok(Array.Empty<object>());
    }

    [HttpGet("trades")]
    public async Task<IActionResult> GetTrades([FromQuery] string exchange = "DERIBIT", [FromQuery] string period = "today")
    {
        var (from, to) = GetPeriodRange(period);
        var key = keyStore.GetKey(exchange);
        if (key == null) return Ok(Array.Empty<object>());

        var creds = new ExchangeCredentials
        {
            Exchange = key.Exchange,
            Fields = key.Fields,
            Testnet = key.Testnet,
        };

        if (exchange.Equals("DERIBIT", StringComparison.OrdinalIgnoreCase))
        {
            var trades = await deribit.FetchTradeHistoryAsync(creds, from, to);
            return Ok(trades);
        }
        if (exchange.Equals("BITMEX", StringComparison.OrdinalIgnoreCase))
        {
            var trades = await bitmex.FetchTradeHistoryAsync(creds, from, to);
            return Ok(trades);
        }
        return Ok(Array.Empty<object>());
    }

    private static (DateTime from, DateTime to) GetPeriodRange(string period)
    {
        var now = DateTime.UtcNow;
        var today = now.Date;
        return period switch
        {
            "yesterday" => (today.AddDays(-1), today),
            "week" => (today.AddDays(-7), now),
            _ => (today, now),
        };
    }
}
