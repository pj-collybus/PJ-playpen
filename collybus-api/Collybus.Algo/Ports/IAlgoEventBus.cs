using Collybus.Algo.Models;

namespace Collybus.Algo.Ports;

public interface IAlgoEventBus
{
    Task PublishStatusAsync(AlgoStatusReport status);
    Task PublishFillAsync(AlgoFill fill);
    Task PublishErrorAsync(string strategyId, string message);
}
