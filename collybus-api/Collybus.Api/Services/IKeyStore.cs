using Collybus.Api.Models;

namespace Collybus.Api.Services;

public interface IKeyStore
{
    bool IsReady { get; }
    KeyEntry? GetKey(string exchange, string? label = null);
    KeyEntry? GetKeyById(string id);
    IReadOnlyList<KeyEntrySafe> ListKeys();
    SaveKeyResult SaveKey(SaveKeyRequest request);
    void DeleteKey(string id);
    Task<TestKeyResult> TestKeyAsync(string id);
}

public record KeyEntry
{
    public string Id { get; init; } = "";
    public string Exchange { get; init; } = "";
    public string Label { get; init; } = "";
    public bool Testnet { get; init; }
    public string Permissions { get; init; } = "read";
    public Dictionary<string, string> Fields { get; init; } = [];
}

public record KeyEntrySafe
{
    public string Id { get; init; } = "";
    public string Exchange { get; init; } = "";
    public string Label { get; init; } = "";
    public bool Testnet { get; init; }
    public string Permissions { get; init; } = "read";
    public string Status { get; init; } = "unknown";
    public string? LastTested { get; init; }
    public Dictionary<string, string?> Fields { get; init; } = [];
}

public record SaveKeyRequest
{
    public string? Id { get; init; }
    public string Exchange { get; init; } = "";
    public string Label { get; init; } = "";
    public Dictionary<string, string> Fields { get; init; } = [];
    public string Permissions { get; init; } = "read";
    public bool Testnet { get; init; }
}

public record SaveKeyResult
{
    public bool Ok { get; init; }
    public string Id { get; init; } = "";
}

public record TestKeyResult
{
    public bool Ok { get; init; }
    public string Message { get; init; } = "";
}
