using Collybus.Api.Models;
using Collybus.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/order")]
public class OrderController(IOrderService orderService, IRiskService riskService) : ControllerBase
{
    [HttpPost("submit")]
    public async Task<IActionResult> Submit([FromBody] SubmitOrderRequest request)
    {
        var risk = riskService.Check(new RiskCheckRequest
        {
            Symbol = request.Symbol,
            Exchange = request.Exchange,
            Side = request.Side,
            Quantity = request.Quantity,
            LimitPrice = request.LimitPrice,
            OrderType = request.OrderType,
        });

        if (!risk.Approved)
            return Ok(new { ok = false, error = risk.RejectReason });

        var order = await orderService.SubmitAsync(request);
        return Ok(new { ok = true, orderId = order.OrderId, state = order.State.ToString() });
    }

    [HttpGet("{orderId}")]
    public async Task<IActionResult> Get(string orderId)
    {
        var order = await orderService.GetAsync(orderId);
        return order is null ? NotFound() : Ok(order);
    }
}
