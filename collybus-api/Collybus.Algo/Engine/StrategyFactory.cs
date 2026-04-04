using Collybus.Algo.Ports;
using Collybus.Algo.Strategies;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Engine;

public class StrategyFactory : IStrategyFactory
{
    private readonly IServiceProvider _services;
    public StrategyFactory(IServiceProvider services) => _services = services;

    public IAlgoStrategy Create(string strategyType, string strategyId) => strategyType.ToUpperInvariant() switch
    {
        "TWAP" => new TwapStrategy(strategyId, _services.GetRequiredService<ILogger<TwapStrategy>>()),
        "VWAP" => new VwapStrategy(strategyId, _services.GetRequiredService<ILogger<VwapStrategy>>()),
        "SNIPER" => new SniperStrategy(strategyId, _services.GetRequiredService<ILogger<SniperStrategy>>()),
        "ICEBERG" => new IcebergStrategy(strategyId, _services.GetRequiredService<ILogger<IcebergStrategy>>()),
        "POV" => new PovStrategy(strategyId, _services.GetRequiredService<ILogger<PovStrategy>>()),
        "IS" => new IsStrategy(strategyId, _services.GetRequiredService<ILogger<IsStrategy>>()),
        _ => throw new ArgumentException($"Unknown strategy type: {strategyType}")
    };
}
