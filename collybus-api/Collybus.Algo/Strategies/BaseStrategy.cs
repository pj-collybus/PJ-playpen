using Collybus.Algo.Models;
using Collybus.Algo.Ports;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

public abstract class BaseStrategy : IAlgoStrategy
{
    protected readonly ILogger Logger;
    protected AlgoParams Params { get; private set; } = null!;
    protected IOrderPort Orders { get; private set; } = null!;
    protected IAlgoEventBus Events { get; private set; } = null!;
    protected CancellationToken Ct { get; private set; }

    public string StrategyId { get; }
    public abstract string StrategyType { get; }
    public AlgoStatus Status { get; protected set; } = AlgoStatus.Waiting;

    // Fill tracking
    protected decimal FilledSize { get; private set; }
    protected decimal RemainingSize => (Params?.TotalSize ?? 0) - FilledSize;
    private decimal _weightedFillPrice;
    protected decimal AvgFillPrice => FilledSize > 0 ? _weightedFillPrice / FilledSize : 0;
    protected decimal FirstFillPrice { get; private set; }
    protected decimal LastFillPrice { get; private set; }

    // Market data
    protected decimal CurrentBid { get; private set; }
    protected decimal CurrentAsk { get; private set; }
    protected decimal CurrentMid { get; private set; }
    protected decimal CurrentSpreadBps { get; private set; }

    // Rolling market VWAP
    private readonly List<(decimal price, decimal size, long ts)> _marketTrades = new();
    protected decimal MarketVwap { get; private set; }

    // Chart + fills
    protected readonly List<AlgoFill> Fills = new();
    protected readonly Dictionary<string, OrderIntent> PendingOrders = new();
    protected int ConsecutiveRejections { get; private set; }
    protected long StartedAt { get; private set; }
    protected long UpdatedAt { get; private set; }

    protected BaseStrategy(string strategyId, ILogger logger)
    {
        StrategyId = strategyId;
        Logger = logger;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    public virtual async Task StartAsync(AlgoParams p, IOrderPort orders, IAlgoEventBus events, CancellationToken ct)
    {
        Params = p; Orders = orders; Events = events; Ct = ct;
        StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        UpdatedAt = StartedAt;

        if (p.StartMode == "trigger" && p.TriggerPrice.HasValue)
        {
            Status = AlgoStatus.Waiting;
            Logger.LogInformation("[{Type}] {Sid} waiting for trigger @ {Price} {Dir}",
                StrategyType, StrategyId, p.TriggerPrice, p.TriggerDirection);
        }
        else
        {
            Status = AlgoStatus.Running;
            await OnActivateAsync();
        }
    }

    public virtual async Task StopAsync()
    {
        Status = AlgoStatus.Stopped;
        await CancelAllPendingAsync();
        Logger.LogInformation("[{Type}] {Sid} stopped: filled={Filled} avg={Avg}",
            StrategyType, StrategyId, FilledSize, AvgFillPrice);
    }

    public virtual Task PauseAsync()
    {
        if (Status == AlgoStatus.Running) Status = AlgoStatus.Paused;
        return Task.CompletedTask;
    }

    public virtual Task ResumeAsync()
    {
        if (Status == AlgoStatus.Paused) Status = AlgoStatus.Running;
        return Task.CompletedTask;
    }

    public virtual Task AccelerateAsync(decimal qty) => Task.CompletedTask;

    // ── Data feeds ──────────────────────────────────────────────────────────
    public virtual void OnMarketData(MarketDataPoint data)
    {
        CurrentBid = data.Bid; CurrentAsk = data.Ask;
        CurrentMid = data.Mid; CurrentSpreadBps = data.SpreadBps;

        if (data.LastTrade > 0 && data.LastTradeSize > 0)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _marketTrades.Add((data.LastTrade, data.LastTradeSize, now));
            var cutoff = now - 300_000;
            _marketTrades.RemoveAll(t => t.ts < cutoff);
            if (_marketTrades.Count > 0)
            {
                var num = _marketTrades.Sum(t => t.price * t.size);
                var den = _marketTrades.Sum(t => t.size);
                MarketVwap = den > 0 ? num / den : data.Mid;
            }
        }

        if (Status == AlgoStatus.Waiting && Params.StartMode == "trigger")
            CheckTrigger(data);
    }

    public virtual void OnFill(AlgoFill fill)
    {
        if (fill.FillSize <= 0) return;
        if (Status is AlgoStatus.Completed or AlgoStatus.Stopped) return;

        FilledSize += fill.FillSize;
        _weightedFillPrice += fill.FillPrice * fill.FillSize;
        if (FirstFillPrice == 0) FirstFillPrice = fill.FillPrice;
        LastFillPrice = fill.FillPrice;
        ConsecutiveRejections = 0;
        UpdatedAt = fill.Timestamp;
        Fills.Add(fill);
        PendingOrders.Remove(fill.ClientOrderId);

        Logger.LogInformation("[{Type}] {Sid} fill: {Size}@{Price} total={Filled}/{Total}",
            StrategyType, StrategyId, fill.FillSize, fill.FillPrice, FilledSize, Params.TotalSize);

        OnFillReceived(fill);

        if (FilledSize >= Params.TotalSize - Params.LotSize / 2)
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
        }
    }

    public virtual void OnOrderRejected(string clientOrderId, string reason)
    {
        ConsecutiveRejections++;
        PendingOrders.Remove(clientOrderId);
        Logger.LogWarning("[{Type}] {Sid} rejected: {Reason} (x{N})",
            StrategyType, StrategyId, reason, ConsecutiveRejections);

        if (ConsecutiveRejections >= 3)
        {
            Status = AlgoStatus.Paused;
            Logger.LogWarning("[{Type}] {Sid} auto-paused after 3 rejections", StrategyType, StrategyId);
        }

        OnRejectionReceived(clientOrderId, reason);
    }

    public abstract Task OnTickAsync();

    // ── Order helpers ───────────────────────────────────────────────────────
    protected async Task<string?> SubmitOrderAsync(OrderIntent intent)
    {
        if (Ct.IsCancellationRequested) return null;
        try
        {
            PendingOrders[intent.ClientOrderId] = intent;
            var exchangeId = await Orders.SubmitAsync(intent);
            return exchangeId;
        }
        catch (Exception ex)
        {
            PendingOrders.Remove(intent.ClientOrderId);
            Logger.LogError(ex, "[{Type}] {Sid} submit failed", StrategyType, StrategyId);
            return null;
        }
    }

    protected async Task CancelAllPendingAsync()
    {
        foreach (var intent in PendingOrders.Values.ToArray())
        {
            try { await Orders.CancelAsync(intent.Exchange, intent.ClientOrderId); } catch { }
        }
        PendingOrders.Clear();
    }

    protected string NewClientOrderId() => $"CLBX-{StrategyId}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";

    protected decimal RoundToLot(decimal qty) => Math.Floor(qty / Params.LotSize) * Params.LotSize;

    protected decimal RoundToTick(decimal price)
    {
        if (Params.TickSize <= 0) return price;
        return Math.Round(price / Params.TickSize) * Params.TickSize;
    }

    private void CheckTrigger(MarketDataPoint data)
    {
        if (!Params.TriggerPrice.HasValue) return;
        var triggered = Params.TriggerDirection?.ToLower() == "above"
            ? data.Mid >= Params.TriggerPrice.Value
            : data.Mid <= Params.TriggerPrice.Value;
        if (triggered)
        {
            Logger.LogInformation("[{Type}] {Sid} trigger @ {Mid}", StrategyType, StrategyId, data.Mid);
            Status = AlgoStatus.Running;
            _ = OnActivateAsync();
        }
    }

    // ── Status ──────────────────────────────────────────────────────────────
    public AlgoStatusReport GetStatus()
    {
        var slip = Tca.TcaCalculator.ArrivalSlippage(AvgFillPrice, Params?.ArrivalMid ?? 0, Params?.Side ?? "BUY");
        var vwap = Tca.TcaCalculator.VwapShortfall(AvgFillPrice, MarketVwap > 0 ? MarketVwap : Params?.ArrivalMid ?? 0, Params?.Side ?? "BUY");
        return new AlgoStatusReport(
            StrategyId, StrategyType, Params?.Exchange ?? "", Params?.Symbol ?? "", Params?.Side ?? "",
            Status, Params?.TotalSize ?? 0, FilledSize, RemainingSize, AvgFillPrice, Params?.ArrivalMid ?? 0,
            slip, vwap, GetCurrentSlice(), GetTotalSlices(), GetNextSliceAt(),
            GetPauseReason(), GetErrorMessage(), StartedAt, UpdatedAt,
            GetSummaryLine(), Fills.TakeLast(100).ToList()
        );
    }

    // ── Hooks ───────────────────────────────────────────────────────────────
    protected virtual Task OnActivateAsync() => Task.CompletedTask;
    protected virtual void OnFillReceived(AlgoFill fill) { }
    protected virtual void OnRejectionReceived(string clientOrderId, string reason) { }
    protected virtual void OnCompleted() { }
    protected virtual int GetCurrentSlice() => 0;
    protected virtual int GetTotalSlices() => 0;
    protected virtual long? GetNextSliceAt() => null;
    protected virtual string? GetPauseReason() => null;
    protected virtual string? GetErrorMessage() => null;
    protected virtual string? GetSummaryLine() => null;
}
