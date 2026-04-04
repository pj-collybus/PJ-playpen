using Collybus.Algo.Engine;
using Collybus.Algo.Models;
using Microsoft.AspNetCore.Mvc;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/algo")]
public class AlgoController(AlgoEngine engine) : ControllerBase
{
    [HttpGet("strategies")]
    public IActionResult GetStrategies() => Ok(new { strategies = new object[]
    {
        new { type = "TWAP", label = "TWAP", description = "Time-Weighted Average Price" },
        new { type = "VWAP", label = "VWAP", description = "Volume-Weighted Average Price" },
        new { type = "SNIPER", label = "Sniper", description = "Price ladder sniper" },
        new { type = "ICEBERG", label = "Iceberg", description = "Hidden size iceberg" },
        new { type = "POV", label = "POV", description = "Percentage of Volume" },
    }});

    [HttpPost("start")]
    public async Task<IActionResult> Start([FromBody] AlgoParams p)
    {
        try
        {
            Console.WriteLine($"[AlgoController] Start: type={p.StrategyType} exchange={p.Exchange} symbol={p.Symbol} side={p.Side} " +
                $"total={p.TotalSize} startMode={p.StartMode} urgency={p.Urgency}");
            Console.WriteLine($"[AlgoController]   iceberg: visibleSize={p.VisibleSize} varianceBps={p.VisibleVariancePct} limitPrice={p.LimitPrice}");
            Console.WriteLine($"[AlgoController]   sniper: mode={p.SniperMode} levels={p.Levels?.Count ?? 0}");
            Console.WriteLine($"[AlgoController]   vwap: mode={p.VwapMode} | pov: pct={p.ParticipationPct}");

            if (string.IsNullOrEmpty(p.StrategyType)) return BadRequest(new { ok = false, error = "strategyType required" });
            var sid = await engine.StartStrategyAsync(p);
            return Ok(new { ok = true, strategyId = sid });
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[AlgoController] ERROR: {ex}");
            return BadRequest(new { ok = false, error = ex.Message, stack = ex.StackTrace });
        }
    }

    [HttpGet("status")]
    public IActionResult GetAllStatuses()
    {
        var strategies = new Dictionary<string, object>();
        foreach (var s in engine.GetAllStatuses()) strategies[s.StrategyId] = s;
        return Ok(new { strategies });
    }

    [HttpGet("status/{sid}")]
    public IActionResult GetStatus(string sid) => engine.GetStatus(sid) is { } s ? Ok(s) : NotFound();

    [HttpPost("stop/{sid}")]
    public async Task<IActionResult> Stop(string sid) { await engine.StopStrategyAsync(sid); return Ok(new { ok = true }); }

    [HttpPost("pause/{sid}")]
    public async Task<IActionResult> Pause(string sid) { await engine.PauseStrategyAsync(sid); return Ok(new { ok = true }); }

    [HttpPost("resume/{sid}")]
    public async Task<IActionResult> Resume(string sid) { await engine.ResumeStrategyAsync(sid); return Ok(new { ok = true }); }

    [HttpPost("accelerate/{sid}")]
    public async Task<IActionResult> Accelerate(string sid, [FromBody] AccelerateRequest req)
    {
        await engine.AccelerateAsync(sid, req.Quantity);
        return Ok(new { ok = true });
    }

    [HttpPost("market-data")]
    public async Task<IActionResult> PushMarketData([FromBody] MarketDataPoint data)
    {
        await engine.PushMarketDataAsync(data);
        return Ok(new { ok = true });
    }
}

public record AccelerateRequest(decimal Quantity);
