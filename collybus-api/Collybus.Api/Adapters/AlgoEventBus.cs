using Collybus.Algo.Models;
using Collybus.Algo.Ports;
using Microsoft.AspNetCore.SignalR;
using Collybus.Api.Hubs;

namespace Collybus.Api.Adapters;

public class AlgoEventBus : IAlgoEventBus
{
    private readonly IHubContext<CollybusHub> _hub;
    public AlgoEventBus(IHubContext<CollybusHub> hub) => _hub = hub;

    public Task PublishStatusAsync(AlgoStatusReport status)
    {
        var orderSample = status.ChartOrder != null && status.ChartOrder.Count > 0
            ? string.Join(",", status.ChartOrder.TakeLast(3).Select(o => o?.ToString("F4") ?? "null"))
            : "empty";
        Console.WriteLine($"[AlgoProgress] sid={status.StrategyId} status={status.Status} bids={status.ChartBids?.Count ?? 0} fills={status.ChartFills?.Count ?? 0} chartOrder.last3=[{orderSample}] restingPrice={status.ActiveOrderPrice}");
        return _hub.Clients.All.SendAsync("AlgoProgress", status);
    }

    public Task PublishFillAsync(AlgoFill fill)
        => _hub.Clients.All.SendAsync("AlgoFillUpdate", fill);

    public Task PublishErrorAsync(string strategyId, string message)
        => _hub.Clients.All.SendAsync("AlgoError", new { strategyId, message });
}
