using Collybus.Api.Adapters;
using Collybus.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/keys")]
public class KeysController(IKeyStore keyStore) : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok(new { keys = keyStore.ListKeys() });

    [HttpPost]
    public IActionResult Save([FromBody] SaveKeyRequest request)
    {
        if (!keyStore.IsReady)
            return Ok(new { ok = false, error = "ENCRYPTION_KEY not configured on server" });
        var result = keyStore.SaveKey(request);
        return Ok(result);
    }

    [HttpPost("{id}/test")]
    public async Task<IActionResult> Test(string id)
    {
        try
        {
            var result = await keyStore.TestKeyAsync(id);
            return Ok(result);
        }
        catch (Exception ex)
        {
            return Ok(new { ok = false, message = ex.Message });
        }
    }

    [HttpDelete("{id}")]
    public IActionResult Delete(string id)
    {
        try { keyStore.DeleteKey(id); return Ok(new { ok = true }); }
        catch (Exception ex) { return Ok(new { ok = false, error = ex.Message }); }
    }

    [HttpPost("subscribe-private")]
    public async Task<IActionResult> SubscribePrivate([FromBody] SubscribePrivateRequest request)
    {
        var results = new Dictionary<string, string>();
        foreach (var exchange in request.Exchanges)
        {
            var key = keyStore.GetKey(exchange);
            if (key == null) { results[exchange] = "no credentials stored"; continue; }
            try
            {
                if (exchange.Equals("DERIBIT", StringComparison.OrdinalIgnoreCase))
                {
                    var adapter = HttpContext.RequestServices.GetRequiredService<DeribitAdapter>();
                    await adapter.ConnectAsync();
                    await adapter.SubscribePrivateAsync(new Collybus.Api.Models.ExchangeCredentials
                    {
                        Exchange = exchange,
                        Fields = key.Fields,
                        Testnet = key.Testnet,
                    });
                }
                results[exchange] = "subscribed";
            }
            catch (Exception ex) { results[exchange] = ex.Message; }
        }
        return Ok(new { ok = true, exchanges = results });
    }
}

public record SubscribePrivateRequest(string[] Exchanges);
