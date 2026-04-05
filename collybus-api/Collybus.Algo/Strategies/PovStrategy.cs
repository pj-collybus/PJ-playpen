using Collybus.Algo.Models;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

/// <summary>
/// POV — Percentage of Volume. Cumulative volume tracking.
/// Fires child orders to maintain target participation rate vs total market volume.
/// </summary>
public class PovStrategy : BaseStrategy
{
    public override string StrategyType => "POV";

    // Config
    private decimal _targetPct;
    private decimal _minChildSize;
    private decimal _maxChildSize;
    private string _urgency = "neutral";
    private string _mode = "pure"; // pure, time_limited, hybrid
    private string _limitMode = "none";
    private decimal _limitPrice;
    private decimal _averageRateLimit;
    private decimal _maxSpreadBps;
    private long _endTs;

    // Cumulative volume tracking
    private decimal _cumMarketVolume;
    private int _childCount;
    private decimal _participationRate;

    // Order tracking
    private string? _activeClientOrderId;
    private bool _placing;
    private string? _pauseReason;

    public PovStrategy(string sid, ILogger<PovStrategy> logger) : base(sid, logger) { }

    protected override Task OnActivateAsync()
    {
        var p = Params;
        _targetPct = p.ParticipationPct ?? 10;
        _minChildSize = p.MinChildSize ?? (p.LotSize * 2);
        _maxChildSize = p.MaxChildSize ?? 0;
        _urgency = p.Urgency ?? "neutral";
        _limitMode = p.LimitMode ?? "none";
        _limitPrice = p.LimitPrice ?? 0;
        _maxSpreadBps = p.MaxSpreadBps ?? 50;
        if (_minChildSize <= 0) _minChildSize = p.LotSize * 2;

        // Mode and duration
        if (p.DurationMinutes.HasValue && p.DurationMinutes > 0)
        {
            _mode = "time_limited";
            _endTs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + (long)p.DurationMinutes.Value * 60_000L;
        }

        Status = AlgoStatus.Running;
        Logger.LogInformation("[POV] {Sid} activated: {Side} {Total} {Symbol} | {Pct}% target | {Urg} | {Mode}",
            StrategyId, p.Side, p.TotalSize, p.Symbol, _targetPct, _urgency, _mode);
        return Task.CompletedTask;
    }

    // ── Market data — cumulative volume tracking ─────────────────────────────
    public override void OnMarketData(MarketDataPoint data)
    {
        base.OnMarketData(data);
        if (data.LastTrade <= 0 || data.LastTradeSize <= 0) return;
        if (Status != AlgoStatus.Running) return;

        _cumMarketVolume += data.LastTradeSize;

        var target = _cumMarketVolume * (_targetPct / 100m);
        var deficit = target - FilledSize;

        // Behind target — fire child
        if (deficit >= _minChildSize && _activeClientOrderId == null && !_placing
            && RemainingSize > _minChildSize * 0.5m)
        {
            var childSize = deficit;
            if (_maxChildSize > 0) childSize = Math.Min(childSize, _maxChildSize);
            childSize = RoundToLot(childSize);
            childSize = Math.Max(_minChildSize, Math.Min(childSize, RemainingSize));
            if (childSize > 0)
                _ = FireChildAsync(childSize);
        }
    }

    // ── Tick — catch-up + time limit ─────────────────────────────────────────
    public override async Task OnTickAsync()
    {
        if (CurrentBid <= 0 || CurrentAsk <= 0) return;
        if (Status != AlgoStatus.Running) return;

        // Completion
        if (RemainingSize <= Params.LotSize / 2)
        {
            Status = AlgoStatus.Completed; OnCompleted(); return;
        }

        // Spread gate
        if (CurrentSpreadBps > _maxSpreadBps) return;

        // Limit check
        if (_limitMode == "market_limit" && _limitPrice > 0)
        {
            if (IsBuy() && CurrentMid > _limitPrice) return;
            if (!IsBuy() && CurrentMid < _limitPrice) return;
        }

        // Time limit
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (_endTs > 0 && now >= _endTs && RemainingSize > 0)
        {
            if (_activeClientOrderId == null && !_placing)
            {
                Logger.LogInformation("[POV] {Sid} time limit reached — sweeping {Rem}", StrategyId, RemainingSize);
                await DoSweep();
            }
            return;
        }

        // Catch-up: if deficit is large and no active order
        var target = _cumMarketVolume * (_targetPct / 100m);
        var deficit = target - FilledSize;
        if (deficit >= _minChildSize * 2 && _activeClientOrderId == null && !_placing && RemainingSize > 0)
        {
            var childSize = RoundToLot(Math.Min(deficit, RemainingSize));
            if (childSize >= _minChildSize)
                await FireChildAsync(childSize);
        }

        // Update participation rate
        _participationRate = _cumMarketVolume > 0 ? FilledSize / _cumMarketVolume * 100 : 0;
    }

    // ── Fire child ───────────────────────────────────────────────────────────
    private async Task FireChildAsync(decimal size)
    {
        if (_placing || _activeClientOrderId != null) return;
        if (CurrentBid <= 0 || CurrentAsk <= 0) return;

        decimal price;
        string tif;
        if (_urgency == "aggressive")
        {
            price = RoundToTick(IsBuy() ? CurrentAsk + Params.TickSize : CurrentBid - Params.TickSize);
            tif = "IOC";
        }
        else if (_urgency == "passive")
        {
            price = RoundToTick(IsBuy() ? CurrentBid : CurrentAsk);
            tif = "GTC";
        }
        else
        {
            price = RoundToTick(CurrentMid);
            tif = "GTC";
        }
        if (price <= 0) return;

        // Hard limit check
        if (_limitMode == "hard_limit" && _limitPrice > 0)
        {
            if (IsBuy() && price > _limitPrice) return;
            if (!IsBuy() && price < _limitPrice) return;
        }

        // Average rate check
        if (_limitMode == "average_rate" && _averageRateLimit > 0 && AvgFillPrice > 0)
        {
            var projAvg = (AvgFillPrice * FilledSize + price * size) / (FilledSize + size);
            if (IsBuy() && projAvg > _averageRateLimit) return;
            if (!IsBuy() && projAvg < _averageRateLimit) return;
        }

        _childCount++;
        _placing = true;
        try
        {
            var cid = NewClientOrderId();
            await SubmitOrderAsync(new OrderIntent(StrategyId, cid, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", size, price, null, tif, Tag: $"pov_{_childCount}"));
            _activeClientOrderId = cid;
        }
        finally { _placing = false; }

        Logger.LogInformation("[POV] {Sid} child #{N}: {Sz} @ {Px} {Tif} | deficit={Def}",
            StrategyId, _childCount, size, price, tif,
            _cumMarketVolume * (_targetPct / 100m) - FilledSize);
    }

    private async Task DoSweep()
    {
        if (RemainingSize <= 0) return;
        var price = RoundToTick(IsBuy() ? CurrentAsk + Params.TickSize * 5 : CurrentBid - Params.TickSize * 5);
        var cid = NewClientOrderId();
        _placing = true;
        try
        {
            await SubmitOrderAsync(new OrderIntent(StrategyId, cid, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", RoundToLot(RemainingSize), price, null, "IOC", Tag: "pov_sweep"));
            _activeClientOrderId = cid;
        }
        finally { _placing = false; }
        Status = AlgoStatus.Completing;
    }

    // ── Fill ─────────────────────────────────────────────────────────────────
    protected override void OnFillReceived(AlgoFill fill)
    {
        if (fill.ClientOrderId == _activeClientOrderId)
        {
            _activeClientOrderId = null;
            _placing = false;
        }
        _participationRate = _cumMarketVolume > 0 ? FilledSize / _cumMarketVolume * 100 : 0;

        Logger.LogInformation("[POV] {Sid} fill: {Sz}@{Px} participation={Rate:F1}% (target {T}%)",
            StrategyId, fill.FillSize, fill.FillPrice, _participationRate, _targetPct);
    }

    // ── Rejection ────────────────────────────────────────────────────────────
    protected override void OnRejectionReceived(string clientOrderId, string reason)
    {
        if (clientOrderId != _activeClientOrderId) return;
        _activeClientOrderId = null;
        _placing = false;
    }

    // ── Pause/Resume ─────────────────────────────────────────────────────────
    protected override void OnPause()
    {
        _activeClientOrderId = null; _placing = false;
        _pauseReason = "manual";
    }

    protected override Task OnResumeAsync()
    {
        _pauseReason = null;
        return Task.CompletedTask;
    }

    // ── Status ───────────────────────────────────────────────────────────────
    protected override string? GetPauseReason() => _pauseReason;
    protected override string? GetSummaryLine()
        => $"{Params.Side} {Params.TotalSize} {Params.Symbol} on {Params.Exchange} via POV | {_targetPct}% target | {_urgency} | {_mode}";

    protected override void PopulateStrategyState(AlgoStatusReport report)
    {
        report.ParticipationRate = _participationRate;
        report.TargetParticipation = _targetPct;
        report.WindowVolume = _cumMarketVolume;
        report.Deficit = Math.Max(0, _cumMarketVolume * (_targetPct / 100m) - FilledSize);
        report.Urgency = _urgency;
    }

    private bool IsBuy() => Params.Side.ToUpper() == "BUY";
}
