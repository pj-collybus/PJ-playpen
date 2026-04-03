using Collybus.Algo.Ports;

namespace Collybus.Algo.Engine;

public interface IStrategyFactory
{
    IAlgoStrategy Create(string strategyType, string strategyId);
}
