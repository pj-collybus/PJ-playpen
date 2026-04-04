using Collybus.Algo.Models;
using Collybus.Algo.Ports;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

/// <summary>
/// ICEBERG — Iceberg execution strategy.
/// Faithful translation of the TypeScript IcebergStrategy class.
/// Splits a large order into randomised visible slices with price chase logic,
/// detection scoring based on fill interval regularity, and configurable urgency.
/// </summary>
public class IcebergStrategy : BaseStrategy
{
    public override string StrategyType => "ICEBERG";

    // ── Public slice state (mirrors TS public fields) ──────────────────────
    private int _slicesFired;
    private int _slicesFilled;
    private decimal _currentSliceSize;
    private int _detectionScore;

    // ── Private configuration (set once in constructor / OnActivateAsync) ──
    private decimal _visibleSize;
    private decimal _visibleVariance;
    private string _urgency = "passive";
    private long _minRefreshMs;
    private long _maxRefreshMs;
    private bool _chaseEnabled;
    private long _chaseDelayMs;
    private string _limitMode = "none";
    private decimal _limitPrice;

    // ── Private runtime state ─────────────────────────────────────────────
    private long _refreshAt;
    private long _chaseAt;
    private long _lastFillTs;
    private readonly List<long> _fillIntervals = new();

    // Active child order tracking
    private string? _activeClientOrderId;
    private decimal? _restingPrice;

    // Pause reason
    private string? _pauseReason;

    private static readonly Random _rng = new();

    public IcebergStrategy(string strategyId, ILogger<IcebergStrategy> logger)
        : base(strategyId, logger)
    {
    }

    /// <summary>
    /// Initialise from Params — mirrors the TS constructor field reads.
    /// Called by the base class lifecycle; Params is already set.
    /// </summary>
    protected override Task OnActivateAsync()
    {
        var p = Params;

        _visibleSize = p.VisibleSize ?? 10;
        _visibleVariance = p.VisibleVariancePct ?? 20;
        _urgency = p.Urgency ?? "passive";
        _minRefreshMs = p.RefreshDelayMs ?? 500;
        _maxRefreshMs = 3000;
        _chaseEnabled = true; // default: enabled unless explicitly 'false'
        _chaseDelayMs = 2000;
        _limitMode = p.LimitMode ?? "none";
        _limitPrice = p.LimitPrice ?? 0;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _refreshAt = now;
        Status = AlgoStatus.Running;

        Logger.LogInformation(
            "[ICEBERG] {Sid} activated: side={Side} total={Total} symbol={Symbol} exchange={Exchange} " +
            "urgency={Urgency} visibleSize={VisibleSize} visibleVariance={VisibleVariance}% " +
            "limitMode={LimitMode} limitPrice={LimitPrice} " +
            "minRefreshMs={MinRefresh} maxRefreshMs={MaxRefresh} chaseEnabled={ChaseEnabled} chaseDelayMs={ChaseDelay}",
            StrategyId, p.Side, p.TotalSize, p.Symbol, p.Exchange,
            _urgency, _visibleSize, _visibleVariance,
            _limitMode, _limitPrice,
            _minRefreshMs, _maxRefreshMs, _chaseEnabled, _chaseDelayMs);

        return Task.CompletedTask;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnTickAsync — exact translation of _onTick
    // ═══════════════════════════════════════════════════════════════════════
    public override async Task OnTickAsync()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var bid = CurrentBid;
        var ask = CurrentAsk;
        var mid = CurrentMid;

        if (Status != AlgoStatus.Running) return;

        if (IsComplete())
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
            return;
        }

        await CheckPriceChase(bid, ask, now);

        if (_activeClientOrderId == null && now >= _refreshAt && RemainingSize > 0.001m)
        {
            await PlaceSlice(bid, ask, mid);
        }
    }

    // ── _checkPriceChase ──────────────────────────────────────────────────
    private async Task CheckPriceChase(decimal bid, decimal ask, long now)
    {
        if (_activeClientOrderId == null || !_chaseEnabled || bid <= 0 || ask <= 0) return;

        var rp = _restingPrice ?? 0;
        var tick = Params.TickSize;

        var movedAway = IsBuy()
            ? bid < rp - tick
            : ask > rp + tick;
        var movedBack = IsBuy()
            ? bid >= rp
            : ask <= rp;

        if (movedAway && _chaseAt == 0)
        {
            _chaseAt = now + _chaseDelayMs;
        }
        else if (movedBack)
        {
            _chaseAt = 0;
        }

        if (_chaseAt > 0 && now >= _chaseAt)
        {
            try { await Orders.CancelAsync(Params.Exchange, _activeClientOrderId); } catch { }
            PendingOrders.Remove(_activeClientOrderId);
            _activeClientOrderId = null;
            _restingPrice = null;
            _chaseAt = 0;
            _refreshAt = now; // repost immediately
        }
    }

    // ── _placeSlice ───────────────────────────────────────────────────────
    private async Task PlaceSlice(decimal bid, decimal ask, decimal mid)
    {
        if (mid <= 0) return;

        var effectiveVariance = _detectionScore > 70
            ? Math.Min(50m, _visibleVariance * 1.5m)
            : _visibleVariance;

        var varianceAmt = _visibleSize * (effectiveVariance / 100m);
        var size = _visibleSize + ((decimal)_rng.NextDouble() * 2 - 1) * varianceAmt;
        size = Math.Max(Params.LotSize, Math.Min(size, RemainingSize));
        size = Math.Max(Params.LotSize, Math.Min(RoundToLot(size), RemainingSize));
        _currentSliceSize = size;

        // Determine price based on urgency
        decimal price;
        if (_urgency == "passive")
            price = IsBuy() ? bid : ask;
        else if (_urgency == "aggressive")
            price = IsBuy() ? ask + Params.TickSize : bid - Params.TickSize;
        else
            price = mid;

        if (price <= 0) price = mid;
        price = RoundToTick(price);

        // Hard limit check
        if (_limitMode == "hard_limit" && _limitPrice > 0)
        {
            if (IsBuy() && price > _limitPrice)
            {
                Status = AlgoStatus.Paused;
                _pauseReason = "Price > limit";
                return;
            }
            if (!IsBuy() && price < _limitPrice)
            {
                Status = AlgoStatus.Paused;
                _pauseReason = "Price < limit";
                return;
            }
        }

        _slicesFired++;

        var clientId = NewClientOrderId();
        await SubmitOrderAsync(new OrderIntent(
            StrategyId, clientId, Params.Exchange, Params.Symbol,
            Params.Side.ToUpper(), "LIMIT", size, price, null, "GTC",
            Tag: $"iceberg_slice_{_slicesFired}"));

        _activeClientOrderId = clientId;
        _restingPrice = price;
        _chaseAt = 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnFillReceived — translation of _onFillExtended
    // ═══════════════════════════════════════════════════════════════════════
    protected override void OnFillReceived(AlgoFill fill)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        _slicesFilled++;

        // Track fill intervals for detection scoring
        if (_lastFillTs > 0)
        {
            _fillIntervals.Add(now - _lastFillTs);
            if (_fillIntervals.Count > 10) _fillIntervals.RemoveAt(0);
            UpdateDetectionScore();
        }
        _lastFillTs = now;

        _activeClientOrderId = null;
        _restingPrice = null;
        _chaseAt = 0;

        // Randomised delay before next slice
        _refreshAt = now + _minRefreshMs + (long)(_rng.NextDouble() * (_maxRefreshMs - _minRefreshMs));

        if (IsComplete())
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnRejectionReceived — translation of _onOrderUpdateExtended
    // ═══════════════════════════════════════════════════════════════════════
    protected override void OnRejectionReceived(string clientOrderId, string reason)
    {
        if (clientOrderId != _activeClientOrderId) return;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Treat as REJECTED
        _activeClientOrderId = null;
        _restingPrice = null;
        _chaseAt = 0;
        _refreshAt = now + 2000;
    }

    // ── _updateDetectionScore ─────────────────────────────────────────────
    private void UpdateDetectionScore()
    {
        if (_fillIntervals.Count < 3)
        {
            _detectionScore = 0;
            return;
        }

        // Take last 5 intervals
        var startIdx = Math.Max(0, _fillIntervals.Count - 5);
        var count = _fillIntervals.Count - startIdx;
        var intervals = _fillIntervals.GetRange(startIdx, count);
        var n = intervals.Count;

        var mean = 0.0;
        foreach (var v in intervals) mean += v;
        mean /= n;

        if (mean == 0)
        {
            _detectionScore = 0;
            return;
        }

        var variance = 0.0;
        foreach (var v in intervals)
        {
            var diff = v - mean;
            variance += diff * diff;
        }
        variance /= n;

        var cv = Math.Sqrt(variance) / mean;

        // CV < 0.2 means very regular = high risk = high score
        _detectionScore = (int)Math.Max(0, Math.Min(100, Math.Round(100.0 * (0.2 - cv) / 0.2)));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Status hooks — translation of _strategyState
    // ═══════════════════════════════════════════════════════════════════════
    protected override int GetCurrentSlice() => _slicesFired;
    protected override int GetTotalSlices() => _slicesFired; // childCount == slicesFired in TS
    protected override string? GetPauseReason() => _pauseReason;

    protected override string? GetSummaryLine()
        => $"{Params.Side} {Params.TotalSize} {Params.Symbol} on {Params.Exchange} via ICEBERG | " +
           $"{_visibleSize} ± {_visibleVariance}% per slice | {_urgency}";

    // ═══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════
    private bool IsBuy() => Params.Side.ToUpper() == "BUY";

    private bool IsComplete() => RemainingSize <= Params.LotSize / 2;
}
