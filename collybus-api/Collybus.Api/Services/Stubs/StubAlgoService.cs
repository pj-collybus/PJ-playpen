using Collybus.Api.Models;

namespace Collybus.Api.Services.Stubs;

public class StubAlgoService : IAlgoService
{
    private readonly Dictionary<string, StrategyState> _strategies = [];

    public Task<StrategyActionResponse> StartAsync(string strategyType, Dictionary<string, object> parameters)
    {
        var id = $"algo-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Guid.NewGuid().ToString()[..8]}";
        _strategies[id] = new StrategyState
        {
            StrategyId = id,
            Type = Enum.Parse<StrategyType>(strategyType, ignoreCase: true),
            Status = StrategyStatus.Running,
            Exchange = parameters.GetValueOrDefault("venue")?.ToString() ?? "DERIBIT",
            Symbol = parameters.GetValueOrDefault("symbol")?.ToString() ?? "",
            Side = parameters.GetValueOrDefault("side")?.ToString() ?? "",
            TotalSize = decimal.Parse(parameters.GetValueOrDefault("totalSize")?.ToString() ?? "0"),
            StartTime = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        return Task.FromResult(new StrategyActionResponse { Ok = true, StrategyId = id });
    }

    public Task<StrategyActionResponse> StopAsync(string strategyId)
    {
        if (_strategies.TryGetValue(strategyId, out var s))
            _strategies[strategyId] = s with { Status = StrategyStatus.Stopped };
        return Task.FromResult(new StrategyActionResponse { Ok = true, StrategyId = strategyId });
    }

    public Task<StrategyActionResponse> PauseAsync(string strategyId)
    {
        if (_strategies.TryGetValue(strategyId, out var s))
            _strategies[strategyId] = s with { Status = StrategyStatus.Paused };
        return Task.FromResult(new StrategyActionResponse { Ok = true, StrategyId = strategyId });
    }

    public Task<StrategyActionResponse> ResumeAsync(string strategyId)
    {
        if (_strategies.TryGetValue(strategyId, out var s))
            _strategies[strategyId] = s with { Status = StrategyStatus.Running };
        return Task.FromResult(new StrategyActionResponse { Ok = true, StrategyId = strategyId });
    }

    public Task<StrategyActionResponse> AccelerateAsync(string strategyId, decimal quantity) =>
        Task.FromResult(new StrategyActionResponse { Ok = true, StrategyId = strategyId });

    public IReadOnlyDictionary<string, StrategyState> GetAll() => _strategies;

    public StrategyState? Get(string strategyId) =>
        _strategies.GetValueOrDefault(strategyId);
}
