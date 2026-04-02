using Collybus.Api.Config;
using Microsoft.AspNetCore.Mvc;

namespace Collybus.Api.Controllers;

[ApiController]
[Route("api/venues")]
public class VenuesController : ControllerBase
{
    [HttpGet]
    public IActionResult GetAll() => Ok(Venues.All.Values);

    [HttpGet("{id}")]
    public IActionResult Get(string id)
    {
        if (Venues.All.TryGetValue(id.ToUpperInvariant(), out var venue))
            return Ok(venue);
        return NotFound();
    }

    [HttpGet("{id}/default-symbol")]
    public async Task<IActionResult> GetDefaultSymbol(string id)
    {
        using var http = new HttpClient();
        http.Timeout = TimeSpan.FromSeconds(10);
        var exchangeUpper = id.ToUpperInvariant();

        try
        {
            var response = await http.GetAsync($"http://localhost:5220/api/marketdata/instruments/{exchangeUpper}");
            if (response.IsSuccessStatusCode)
            {
                var json = await response.Content.ReadAsStringAsync();
                using var doc = System.Text.Json.JsonDocument.Parse(json);
                var arr = doc.RootElement;
                foreach (var item in arr.EnumerateArray())
                {
                    if (item.TryGetProperty("isPerp", out var ip) && ip.GetBoolean())
                    {
                        var sym = item.GetProperty("symbol").GetString();
                        if (!string.IsNullOrEmpty(sym))
                            return Ok(new { symbol = sym });
                    }
                }
                if (arr.GetArrayLength() > 0)
                {
                    var sym = arr[0].GetProperty("symbol").GetString();
                    return Ok(new { symbol = sym ?? "" });
                }
            }
        }
        catch { }

        return Ok(new { symbol = "" });
    }
}
