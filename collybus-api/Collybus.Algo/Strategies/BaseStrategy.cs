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
    protected int ConsecutiveRejections { get; set; }
    protected long StartedAt { get; private set; }
    protected long UpdatedAt { get; private set; }

    // Chart sampling (1 sample per tick, ~1s)
    private readonly List<long> _chartTimes = new();
    private readonly List<decimal> _chartBids = new();
    private readonly List<decimal> _chartAsks = new();
    private readonly List<decimal?> _chartOrder = new();
    private readonly List<decimal> _chartVwap = new();
    private readonly List<ChartFillPoint> _chartFills = new();
    private readonly List<ChildOrderSummary> _childOrders = new();
    private const int MaxChartPoints = 3600;
    protected decimal? RestingPrice { get; set; }

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
        if (PendingOrders.Count > 0)
            Logger.LogInformation("[{Type}] {Sid} stopping — cancelling {Count} pending orders: {Ids}",
                StrategyType, StrategyId, PendingOrders.Count,
                string.Join(", ", PendingOrders.Keys));
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
        // Only update bid/ask/mid/spread from ticker data (non-zero), not from trade-only messages
        if (data.Bid > 0) CurrentBid = data.Bid;
        if (data.Ask > 0) CurrentAsk = data.Ask;
        if (data.Mid > 0) CurrentMid = data.Mid;
        if (data.SpreadBps > 0) CurrentSpreadBps = data.SpreadBps;

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

        // Chart sampling — sample once per second from ticker updates (not trade-only messages)
        if (data.Bid > 0 && data.Ask > 0 && data.Bid < data.Ask
            && (data.Ask - data.Bid) / data.Bid <= 0.05m) // skip if spread > 5%
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (_chartTimes.Count == 0 || now - _chartTimes[^1] >= 900)
            {
                _chartTimes.Add(now);
                _chartBids.Add(data.Bid);
                _chartAsks.Add(data.Ask);
                _chartOrder.Add(RestingPrice > 0 ? RestingPrice : null);
                _chartVwap.Add(MarketVwap > 0 ? MarketVwap : 0);
                if (_chartTimes.Count > MaxChartPoints)
                {
                    _chartTimes.RemoveAt(0); _chartBids.RemoveAt(0);
                    _chartAsks.RemoveAt(0); _chartOrder.RemoveAt(0);
                    _chartVwap.RemoveAt(0);
                }
            }
        }
    }

    public virtual void OnFill(AlgoFill fill)
    {
        if (fill.FillSize <= 0) return;

        // Get order tag before any removal
        var fillTag = PendingOrders.TryGetValue(fill.ClientOrderId, out var intent) ? intent.Tag : null;

        // ALWAYS record chart fill FIRST — before any guard, before completion check
        _chartFills.Add(new ChartFillPoint
        {
            Time = fill.Timestamp,
            Price = fill.FillPrice,
            Size = fill.FillSize,
            Side = Params?.Side ?? "BUY",
            FillType = fillTag ?? "fill",
        });

        // Update child order blotter even if completed (so UI sees all fills)
        var childOrder = _childOrders.FindLast(c => c.ClientOrderId == fill.ClientOrderId);
        if (childOrder != null)
        {
            childOrder.Filled += fill.FillSize;
            childOrder.AvgFillPrice = fill.FillPrice;
            childOrder.Status = "filled";
        }

        if (Status is AlgoStatus.Completed or AlgoStatus.Stopped)
        {
            Logger.LogWarning("[{Type}] {Sid} fill after {Status}: {Size}@{Price} (chart recorded, accounting skipped)",
                StrategyType, StrategyId, Status, fill.FillSize, fill.FillPrice);
            return;
        }

        // Overfill protection — cap to remaining
        var effectiveSize = Math.Min(fill.FillSize, Math.Max(RemainingSize, 0));
        if (effectiveSize <= 0)
        {
            Logger.LogWarning("[{Type}] {Sid} fill capped to 0: fillSize={Raw} remaining={Rem}",
                StrategyType, StrategyId, fill.FillSize, RemainingSize);
            return;
        }

        var beforeFilled = FilledSize;
        FilledSize += effectiveSize;
        _weightedFillPrice += fill.FillPrice * effectiveSize;
        if (FirstFillPrice == 0) FirstFillPrice = fill.FillPrice;
        LastFillPrice = fill.FillPrice;
        ConsecutiveRejections = 0;
        UpdatedAt = fill.Timestamp;

        PendingOrders.Remove(fill.ClientOrderId);
        var recordedFill = effectiveSize < fill.FillSize
            ? fill with { FillSize = effectiveSize, Tag = fillTag }
            : fill with { Tag = fillTag };
        Fills.Add(recordedFill);

        Logger.LogInformation("[{Type}] {Sid} fill: raw={Raw} capped={Capped}@{Price} remaining={RemBefore}→{RemAfter} filled={Before}→{After}/{Total}",
            StrategyType, StrategyId, fill.FillSize, effectiveSize, fill.FillPrice,
            beforeFilled > 0 ? Params.TotalSize - beforeFilled : Params.TotalSize, RemainingSize,
            beforeFilled, FilledSize, Params.TotalSize);

        OnFillReceived(recordedFill);

        if (FilledSize >= Params.TotalSize - Params.LotSize / 2)
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
            // Force immediate status push so UI gets final state with all fills
            try { _ = Events.PublishStatusAsync(GetStatus()); } catch { }
        }
    }

    public virtual void OnOrderRejected(string clientOrderId, string reason)
    {
        ConsecutiveRejections++;
        PendingOrders.Remove(clientOrderId);
        var co = _childOrders.FindLast(c => c.ClientOrderId == clientOrderId);
        if (co != null) co.Status = "rejected";
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
            // Track child order for blotter
            _childOrders.Add(new ChildOrderSummary
            {
                Time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Side = intent.Side,
                Size = intent.Quantity,
                Price = intent.LimitPrice ?? 0,
                Status = "open",
                Tag = intent.Tag,
                ClientOrderId = intent.ClientOrderId,
            });
            if (_childOrders.Count > 200) _childOrders.RemoveAt(0);

            var exchangeId = await Orders.SubmitAsync(intent);
            return exchangeId;
        }
        catch (Exception ex)
        {
            PendingOrders.Remove(intent.ClientOrderId);
            // Mark child order as rejected
            var co = _childOrders.FindLast(c => c.ClientOrderId == intent.ClientOrderId);
            if (co != null) co.Status = "rejected";
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
        var vwapSlip = Tca.TcaCalculator.VwapShortfall(AvgFillPrice, MarketVwap > 0 ? MarketVwap : Params?.ArrivalMid ?? 0, Params?.Side ?? "BUY");
        var report = new AlgoStatusReport
        {
            StrategyId = StrategyId,
            StrategyType = StrategyType,
            Exchange = Params?.Exchange ?? "",
            Symbol = Params?.Symbol ?? "",
            Side = Params?.Side ?? "",
            Status = Status,
            TotalSize = Params?.TotalSize ?? 0,
            FilledSize = FilledSize,
            RemainingSize = RemainingSize,
            AvgFillPrice = AvgFillPrice,
            ArrivalMid = Params?.ArrivalMid ?? 0,
            SlippageBps = slip,
            VwapShortfallBps = vwapSlip,
            CurrentSlice = GetCurrentSlice(),
            TotalSlices = GetTotalSlices(),
            NextSliceAt = GetNextSliceAt(),
            PauseReason = GetPauseReason(),
            ErrorMessage = GetErrorMessage(),
            StartedAt = StartedAt,
            UpdatedAt = UpdatedAt,
            SummaryLine = GetSummaryLine(),
            Fills = Fills.TakeLast(100).ToList(),
            ActiveOrderPrice = RestingPrice,
            TickSize = Params?.TickSize,
            // Chart data
            ChartTimes = _chartTimes.ToList(),
            ChartBids = _chartBids.ToList(),
            ChartAsks = _chartAsks.ToList(),
            ChartOrder = _chartOrder.ToList(),
            ChartFills = _chartFills.ToList(),
            ChartVwap = _chartVwap.ToList(),
            // Child orders blotter
            ChildOrders = _childOrders.TakeLast(50).Reverse().ToList(),
        };
        // Let strategy subclass populate extra fields
        PopulateStrategyState(report);
        return report;
    }

    /// <summary>Override to populate strategy-specific fields on the status report.</summary>
    protected virtual void PopulateStrategyState(AlgoStatusReport report) { }

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
