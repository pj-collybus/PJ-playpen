using Microsoft.AspNetCore.Mvc;
using System.Text.Json;

namespace Collybus.Api.Controllers;

public record LayoutPanel(
    string Id, string Type,
    int X, int Y, int Width,
    JsonElement Config
);

public record LayoutDto(
    string Id, string Name,
    List<LayoutPanel> Panels,
    DateTime UpdatedAt
);

[ApiController]
[Route("api/layouts")]
public class LayoutsController : ControllerBase
{
    private static readonly string StorePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Collybus", "layouts.json"
    );

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    private List<LayoutDto> ReadAll()
    {
        if (!System.IO.File.Exists(StorePath)) return new();
        var json = System.IO.File.ReadAllText(StorePath);
        return JsonSerializer.Deserialize<List<LayoutDto>>(json, JsonOpts) ?? new();
    }

    private void WriteAll(List<LayoutDto> layouts)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StorePath)!);
        System.IO.File.WriteAllText(StorePath, JsonSerializer.Serialize(layouts, JsonOpts));
    }

    [HttpGet]
    public IActionResult GetAll() => Ok(ReadAll());

    [HttpPost]
    public IActionResult Save([FromBody] LayoutDto layout)
    {
        var layouts = ReadAll();
        var idx = layouts.FindIndex(l => l.Id == layout.Id);
        var updated = layout with { UpdatedAt = DateTime.UtcNow };
        if (idx >= 0) layouts[idx] = updated;
        else layouts.Add(updated);
        WriteAll(layouts);
        return Ok(updated);
    }

    [HttpDelete("{id}")]
    public IActionResult Delete(string id)
    {
        var layouts = ReadAll();
        layouts.RemoveAll(l => l.Id == id);
        WriteAll(layouts);
        return Ok(new { ok = true });
    }

    [HttpPut("reorder")]
    public IActionResult Reorder([FromBody] List<string> orderedIds)
    {
        var layouts = ReadAll();
        var reordered = orderedIds
            .Select(id => layouts.FirstOrDefault(l => l.Id == id))
            .Where(l => l != null)
            .Cast<LayoutDto>()
            .ToList();
        reordered.AddRange(layouts.Where(l => !orderedIds.Contains(l.Id)));
        WriteAll(reordered);
        return Ok(reordered);
    }

    [HttpPut("bulk")]
    public IActionResult SaveAll([FromBody] List<LayoutDto> layouts)
    {
        WriteAll(layouts.Select(l => l with { UpdatedAt = DateTime.UtcNow }).ToList());
        return Ok(new { ok = true, count = layouts.Count });
    }
}
