using Collybus.Api.Adapters;
using Collybus.Api.Models;
using Collybus.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/order")]
public class OrderController(IOrderService orderService, IRiskService riskService, IKeyStore keyStore, IEnumerable<IExchangeAdapter> adapters) : ControllerBase
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

    [HttpPost("cancel")]
    public async Task<IActionResult> Cancel([FromBody] CancelOrderRequest request)
    {
        var key = keyStore.GetKey(request.Exchange);
        if (key == null) return Ok(new { ok = false, error = "No credentials" });

        var creds = new ExchangeCredentials { Exchange = key.Exchange, Fields = key.Fields, Testnet = key.Testnet };
        var adapter = adapters.FirstOrDefault(a => a.Venue.Equals(request.Exchange, StringComparison.OrdinalIgnoreCase));
        if (adapter == null) return Ok(new { ok = false, error = "No adapter" });

        var result = await adapter.CancelOrderAsync(request.OrderId, creds);
        return Ok(result);
    }

    [HttpPost("amend")]
    public async Task<IActionResult> Amend([FromBody] AmendOrderRequest request)
    {
        var key = keyStore.GetKey(request.Exchange);
        if (key == null) return Ok(new { ok = false, error = "No credentials" });
        var creds = new ExchangeCredentials { Exchange = key.Exchange, Fields = key.Fields, Testnet = key.Testnet };
        var adapter = adapters.FirstOrDefault(a => a.Venue.Equals(request.Exchange, StringComparison.OrdinalIgnoreCase));
        if (adapter == null) return Ok(new { ok = false, error = "No adapter" });
        var result = await adapter.AmendOrderAsync(request.OrderId, request.Quantity, request.LimitPrice, creds);
        return Ok(result);
    }

    [HttpGet("{orderId}")]
    public async Task<IActionResult> Get(string orderId)
    {
        var order = await orderService.GetAsync(orderId);
        return order is null ? NotFound() : Ok(order);
    }
}
