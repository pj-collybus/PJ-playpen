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
        => _hub.Clients.All.SendAsync("AlgoProgress", status);

    public Task PublishFillAsync(AlgoFill fill)
        => _hub.Clients.All.SendAsync("AlgoFillUpdate", fill);

    public Task PublishErrorAsync(string strategyId, string message)
        => _hub.Clients.All.SendAsync("AlgoError", new { strategyId, message });
}
