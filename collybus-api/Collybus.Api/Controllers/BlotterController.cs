using Collybus.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/blotter")]
public class BlotterController(IBlotterService blotterService) : ControllerBase
{
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
}
