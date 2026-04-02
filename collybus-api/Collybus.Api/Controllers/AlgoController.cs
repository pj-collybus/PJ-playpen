using Collybus.Api.Models;
using Collybus.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/algo")]
public class AlgoController(IAlgoService algoService) : ControllerBase
{
    [HttpPost("start")]
    public async Task<IActionResult> Start([FromBody] StartStrategyRequest request)
    {
        if (string.IsNullOrEmpty(request.StrategyType))
            return BadRequest(new { error = "strategyType required" });

        var result = await algoService.StartAsync(request.StrategyType, request.Params);
        return Ok(result);
    }

    [HttpPost("stop/{strategyId}")]
    public async Task<IActionResult> Stop(string strategyId)
    {
        var result = await algoService.StopAsync(strategyId);
        return Ok(result);
    }

    [HttpPost("pause/{strategyId}")]
    public async Task<IActionResult> Pause(string strategyId)
    {
        var result = await algoService.PauseAsync(strategyId);
        return Ok(result);
    }

    [HttpPost("resume/{strategyId}")]
    public async Task<IActionResult> Resume(string strategyId)
    {
        var result = await algoService.ResumeAsync(strategyId);
        return Ok(result);
    }

    [HttpPost("accelerate/{strategyId}")]
    public async Task<IActionResult> Accelerate(string strategyId, [FromBody] AccelerateRequest request)
    {
        var result = await algoService.AccelerateAsync(strategyId, request.Quantity);
        return Ok(result);
    }

    [HttpGet("status")]
    public IActionResult GetStatus()
    {
        return Ok(new { strategies = algoService.GetAll() });
    }
}

public record AccelerateRequest(decimal Quantity);
