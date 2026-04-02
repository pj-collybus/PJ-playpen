using Collybus.Api.Models;

namespace Collybus.Api.Services;

public interface IAlgoService
{
    Task<StrategyActionResponse> StartAsync(string strategyType, Dictionary<string, object> parameters);
    Task<StrategyActionResponse> StopAsync(string strategyId);
    Task<StrategyActionResponse> PauseAsync(string strategyId);
    Task<StrategyActionResponse> ResumeAsync(string strategyId);
    Task<StrategyActionResponse> AccelerateAsync(string strategyId, decimal quantity);
    IReadOnlyDictionary<string, StrategyState> GetAll();
    StrategyState? Get(string strategyId);
}
