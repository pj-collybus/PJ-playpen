using Microsoft.AspNetCore.SignalR;

namespace Collybus.Api.Hubs;

public class CollybusHub : Hub
{
    private readonly ILogger<CollybusHub> _logger;

    public CollybusHub(ILogger<CollybusHub> logger)
    {
        _logger = logger;
    }

    public override async Task OnConnectedAsync()
    {
        _logger.LogInformation("Client connected: {ConnectionId}", Context.ConnectionId);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        _logger.LogInformation("Client disconnected: {ConnectionId}", Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    public async Task Subscribe(string[] channels)
    {
        foreach (var channel in channels)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, channel);
            _logger.LogDebug("Client {Id} subscribed to {Channel}", Context.ConnectionId, channel);
        }
    }

    public async Task Unsubscribe(string[] channels)
    {
        foreach (var channel in channels)
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, channel);
        }
    }

    public async Task SubscribeSymbol(string exchange, string symbol)
    {
        var key = $"{exchange}:{symbol}";
        await Groups.AddToGroupAsync(Context.ConnectionId, key);
        _logger.LogInformation("Client {Id} joined group {Key}", Context.ConnectionId, key);
    }

    public async Task UnsubscribeSymbol(string exchange, string symbol)
    {
        var key = $"{exchange}:{symbol}";
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, key);
        _logger.LogInformation("Client {Id} left group {Key}", Context.ConnectionId, key);
    }
}
