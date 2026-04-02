using Collybus.Api.Models;

namespace Collybus.Api.Services.Stubs;

public class StubBlotterService : IBlotterService
{
    public Task StartAsync(CancellationToken ct = default) => Task.CompletedTask;

    public BlotterSnapshot GetSnapshot(string? exchange = null) => new()
    {
        Orders = [],
        Trades = [],
        Positions = [],
        Balances = [],
    };

    public IReadOnlyList<Position> GetPositions(string? exchange = null) => [];
    public IReadOnlyList<Balance> GetBalances(string? exchange = null) => [];
}
