using Collybus.Algo.Models;

namespace Collybus.Algo.Ports;

public interface IAlgoStrategy
{
    string StrategyId { get; }
    string StrategyType { get; }
    string Symbol { get; }
    AlgoStatus Status { get; }
    AlgoStatusReport GetStatus();

    Task StartAsync(AlgoParams p, IOrderPort orders, IAlgoEventBus events, CancellationToken ct);
    Task StopAsync();
    Task PauseAsync();
    Task ResumeAsync();
    Task AccelerateAsync(decimal qty);

    void OnMarketData(MarketDataPoint data);
    void OnFill(AlgoFill fill);
    void OnOrderRejected(string clientOrderId, string reason);
    Task OnTickAsync();
}
