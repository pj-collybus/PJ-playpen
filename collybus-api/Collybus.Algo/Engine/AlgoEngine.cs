using System.Collections.Concurrent;
using System.Threading.Channels;
using Collybus.Algo.Models;
using Collybus.Algo.Ports;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Engine;

// ── Messages ────────────────────────────────────────────────────────────────
public abstract record AlgoMessage;
public record StartMessage(string StrategyId, AlgoParams Params) : AlgoMessage;
public record StopMessage(string StrategyId) : AlgoMessage;
public record PauseMessage(string StrategyId) : AlgoMessage;
public record ResumeMessage(string StrategyId) : AlgoMessage;
public record AccelerateMessage(string StrategyId, decimal Qty) : AlgoMessage;
public record MarketDataMessage(string StrategyId, MarketDataPoint Data) : AlgoMessage;
public record FillMessage(string StrategyId, AlgoFill Fill) : AlgoMessage;
public record OrderRejectedMessage(string StrategyId, string ClientOrderId, string Reason) : AlgoMessage;

public class AlgoEngine : BackgroundService
{
    private readonly Channel<AlgoMessage> _channel;
    private readonly ConcurrentDictionary<string, IAlgoStrategy> _strategies = new();
    private readonly IStrategyFactory _factory;
    private readonly IOrderPort _orders;
    private readonly IAlgoEventBus _events;
    private readonly ILogger<AlgoEngine> _log;
    private int _ordersThisSec;
    private DateTime _rateWindow = DateTime.UtcNow;

    public AlgoEngine(IStrategyFactory factory, IOrderPort orders, IAlgoEventBus events, ILogger<AlgoEngine> log)
    {
        _factory = factory;
        _orders = orders;
        _events = events;
        _log = log;
        _channel = Channel.CreateBounded<AlgoMessage>(new BoundedChannelOptions(1000)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleWriter = false,
            SingleReader = true,
        });
    }

    // ── Public API ──────────────────────────────────────────────────────────
    public async Task<string> StartStrategyAsync(AlgoParams p)
    {
        var sid = Guid.NewGuid().ToString("N")[..12];
        var strategy = _factory.Create(p.StrategyType, sid);
        _strategies[sid] = strategy;
        await _channel.Writer.WriteAsync(new StartMessage(sid, p));
        _log.LogInformation("[AlgoEngine] StartStrategy {Type} {Sid}", p.StrategyType, sid);
        return sid;
    }

    public Task StopStrategyAsync(string sid) => _channel.Writer.WriteAsync(new StopMessage(sid)).AsTask();
    public Task PauseStrategyAsync(string sid) => _channel.Writer.WriteAsync(new PauseMessage(sid)).AsTask();
    public Task ResumeStrategyAsync(string sid) => _channel.Writer.WriteAsync(new ResumeMessage(sid)).AsTask();
    public Task AccelerateAsync(string sid, decimal qty) => _channel.Writer.WriteAsync(new AccelerateMessage(sid, qty)).AsTask();

    public Task PushMarketDataAsync(MarketDataPoint data)
    {
        foreach (var (sid, s) in _strategies)
        {
            if (s.Status is AlgoStatus.Running or AlgoStatus.Waiting or AlgoStatus.Completing)
                _channel.Writer.TryWrite(new MarketDataMessage(sid, data));
        }
        return Task.CompletedTask;
    }

    public Task PushFillAsync(AlgoFill fill) => _channel.Writer.WriteAsync(new FillMessage(fill.StrategyId, fill)).AsTask();
    public Task PushOrderRejectedAsync(string sid, string clientOrderId, string reason)
        => _channel.Writer.WriteAsync(new OrderRejectedMessage(sid, clientOrderId, reason)).AsTask();

    public List<AlgoStatusReport> GetAllStatuses() => _strategies.Values.Select(s => s.GetStatus()).ToList();
    public AlgoStatusReport? GetStatus(string sid) => _strategies.TryGetValue(sid, out var s) ? s.GetStatus() : null;

    // ── BackgroundService ───────────────────────────────────────────────────
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _ = TickLoopAsync(ct);
        await foreach (var msg in _channel.Reader.ReadAllAsync(ct))
        {
            try { await DispatchAsync(msg, ct); }
            catch (Exception ex) { _log.LogError(ex, "[AlgoEngine] Dispatch error: {Msg}", msg.GetType().Name); }
        }
    }

    private async Task DispatchAsync(AlgoMessage msg, CancellationToken ct)
    {
        switch (msg)
        {
            case StartMessage m when _strategies.TryGetValue(m.StrategyId, out var s):
                await s.StartAsync(m.Params, _orders, _events, ct); break;
            case StopMessage m when _strategies.TryGetValue(m.StrategyId, out var s):
                await s.StopAsync(); break;
            case PauseMessage m when _strategies.TryGetValue(m.StrategyId, out var s):
                await s.PauseAsync(); break;
            case ResumeMessage m when _strategies.TryGetValue(m.StrategyId, out var s):
                await s.ResumeAsync(); break;
            case AccelerateMessage m when _strategies.TryGetValue(m.StrategyId, out var s):
                await s.AccelerateAsync(m.Qty); break;
            case MarketDataMessage m when _strategies.TryGetValue(m.StrategyId, out var s):
                s.OnMarketData(m.Data); break;
            case FillMessage m when _strategies.TryGetValue(m.StrategyId, out var s):
                s.OnFill(m.Fill); break;
            case OrderRejectedMessage m when _strategies.TryGetValue(m.StrategyId, out var s):
                s.OnOrderRejected(m.ClientOrderId, m.Reason); break;
        }
    }

    private async Task TickLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (await timer.WaitForNextTickAsync(ct))
        {
            ResetRateWindow();
            foreach (var (sid, strategy) in _strategies.ToArray())
            {
                if (strategy.Status is AlgoStatus.Running or AlgoStatus.Completing)
                {
                    try { await strategy.OnTickAsync(); }
                    catch (Exception ex) { _log.LogError(ex, "[AlgoEngine] Tick error {Sid}", sid); }
                }
            }
            foreach (var strategy in _strategies.Values.ToArray())
            {
                if (strategy.Status is not AlgoStatus.Completed and not AlgoStatus.Stopped)
                    await _events.PublishStatusAsync(strategy.GetStatus());
            }
        }
    }

    private void ResetRateWindow()
    {
        var now = DateTime.UtcNow;
        if ((now - _rateWindow).TotalSeconds >= 1) { _ordersThisSec = 0; _rateWindow = now; }
    }

    public bool TryConsumeOrderSlot()
    {
        if (_ordersThisSec >= 10) return false;
        Interlocked.Increment(ref _ordersThisSec);
        return true;
    }
}
