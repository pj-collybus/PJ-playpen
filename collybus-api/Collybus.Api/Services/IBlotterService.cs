using Collybus.Api.Models;

namespace Collybus.Api.Services;

public interface IBlotterService
{
    Task StartAsync(CancellationToken ct = default);
    BlotterSnapshot GetSnapshot(string? exchange = null);
    IReadOnlyList<Position> GetPositions(string? exchange = null);
    IReadOnlyList<Balance> GetBalances(string? exchange = null);
}

public record BlotterSnapshot
{
    public IReadOnlyList<Order> Orders { get; init; } = [];
    public IReadOnlyList<Fill> Trades { get; init; } = [];
    public IReadOnlyList<Position> Positions { get; init; } = [];
    public IReadOnlyList<Balance> Balances { get; init; } = [];
}
