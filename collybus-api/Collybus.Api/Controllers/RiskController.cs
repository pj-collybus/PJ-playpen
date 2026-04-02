using Collybus.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/risk")]
public class RiskController(IRiskService riskService) : ControllerBase
{
    [HttpPost("check")]
    public IActionResult Check([FromBody] RiskCheckRequest request)
    {
        return Ok(riskService.Check(request));
    }

    [HttpGet("headroom")]
    public IActionResult GetHeadroom([FromQuery] string symbol, [FromQuery] string exchange, [FromQuery] string? accountId)
    {
        return Ok(riskService.GetHeadroom(symbol, exchange, accountId));
    }
}
