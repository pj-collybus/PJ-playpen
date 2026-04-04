using Collybus.Algo.Models;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

/// <summary>
/// VWAP — Volume-Weighted Average Price execution strategy.
/// Faithful translation of the TypeScript VWAPStrategy class.
/// Three modes: realtime (within participation band around rolling VWAP),
/// benchmark (auto-adjust urgency based on slippage vs VWAP),
/// historical (U-shaped volume profile weighting).
/// </summary>
public class VwapStrategy : BaseStrategy
{
    public override string StrategyType => "VWAP";

    // ── Public state (mirrors TS public fields) ───────────────────────────
    private decimal _rollingVwap;
    private decimal _arrivalVwap;
    private decimal _deviationFromVwap;
    private bool _inParticipationBand;
    private decimal _profileWeight = 1.0m;
    private string _currentUrgency = "passive";
    private decimal _slippageVsVwap;
    private int _slicesFired;
    private int _slicesTotal;
    private long _nextSliceAt;

    // ── Private configuration ─────────────────────────────────────────────
    private string _vwapMode = "realtime";
    private string _baseUrgency = "passive";
    private decimal _lotSize;
    private long _vwapWindowMs;
    private decimal _bandBps;
    private decimal _maxDeviationBps;
    private decimal _variancePct;
    private string _limitMode = "none";
    private decimal _limitPrice;
    private long _durationMs;

    // ── Private runtime state ─────────────────────────────────────────────
    private readonly List<(decimal price, decimal size, long ts)> _rollingTrades = new();
    private long _chaseAt;
    private long _intervalMs;
    private long _completingDeadline;
    private long _endTs;
    private long _startTs;

    // Active child order tracking
    private string? _restingClientOrderId;
    private decimal _restingPrice;

    // Pause reason
    private string? _pauseReason;

    private static readonly Random _rng = new();

    public VwapStrategy(string strategyId, ILogger<VwapStrategy> logger)
        : base(strategyId, logger)
    {
    }

    /// <summary>
    /// Initialise from Params — mirrors the TS constructor field reads + _onActivate.
    /// </summary>
    protected override Task OnActivateAsync()
    {
        var p = Params;

        // Constructor-equivalent reads from params
        _vwapMode = p.VwapMode ?? "realtime";
        _baseUrgency = p.Urgency ?? "passive";
        _currentUrgency = _baseUrgency;
        _lotSize = p.LotSize > 0 ? p.LotSize : 1;
        _vwapWindowMs = (p.VwapWindowSeconds ?? 1800) * 1000L;
        _bandBps = p.ParticipationBandBps ?? 10;
        _maxDeviationBps = p.MaxDeviationBps ?? 50;
        _variancePct = p.ScheduleVariancePct ?? 10;
        _limitMode = p.LimitMode ?? "none";
        _limitPrice = p.LimitPrice ?? 0;
        _durationMs = (p.DurationMinutes ?? 30) * 60_000L;

        // _onActivate logic
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _startTs = now;
        _endTs = now + _durationMs;
        _arrivalVwap = _rollingVwap > 0 ? _rollingVwap : p.ArrivalMid;
        _slicesTotal = Math.Max(2, Math.Min(500, (int)Math.Round((double)_durationMs / 60_000.0)));
        _intervalMs = _durationMs / _slicesTotal;
        _nextSliceAt = now;
        Status = AlgoStatus.Running;

        Logger.LogInformation(
            "[VWAP] {Sid} activated: side={Side} total={Total} symbol={Symbol} exchange={Exchange} " +
            "mode={Mode} urgency={Urgency} duration={Dur}ms slices={Slices} interval={Interval}ms " +
            "bandBps={Band} maxDevBps={MaxDev} limitMode={LimitMode} limitPrice={LimitPrice}",
            StrategyId, p.Side, p.TotalSize, p.Symbol, p.Exchange,
            _vwapMode, _baseUrgency, _durationMs, _slicesTotal, _intervalMs,
            _bandBps, _maxDeviationBps, _limitMode, _limitPrice);

        return Task.CompletedTask;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnMarketData — translation of onTrade
    // ═══════════════════════════════════════════════════════════════════════
    public override void OnMarketData(MarketDataPoint data)
    {
        base.OnMarketData(data);

        if (data.LastTrade <= 0 || data.LastTradeSize <= 0) return;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _rollingTrades.Add((data.LastTrade, data.LastTradeSize, now));
        ExpireTrades();
        RecalcVwap();

        // VWAP cross trigger
        if (Status == AlgoStatus.Waiting)
        {
            var mid = data.Mid;
            if (mid > 0 && _rollingVwap > 0)
            {
                var crossed = IsBuy()
                    ? mid <= _rollingVwap
                    : mid >= _rollingVwap;
                if (crossed)
                {
                    Status = AlgoStatus.Running;
                    _ = OnActivateAsync();
                }
            }
        }
    }

    private void ExpireTrades()
    {
        var cutoff = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _vwapWindowMs;
        while (_rollingTrades.Count > 0 && _rollingTrades[0].ts < cutoff)
            _rollingTrades.RemoveAt(0);
    }

    private void RecalcVwap()
    {
        decimal n = 0, v = 0;
        foreach (var t in _rollingTrades)
        {
            n += t.price * t.size;
            v += t.size;
        }
        _rollingVwap = v > 0 ? n / v : _rollingVwap;
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

        // Deviation calculation
        if (mid > 0 && _rollingVwap > 0)
        {
            _deviationFromVwap = (mid - _rollingVwap) / _rollingVwap * 10_000m;
            _inParticipationBand = Math.Abs(_deviationFromVwap) <= _bandBps;
        }

        // VWAP deviation auto-pause (realtime mode)
        if (Status == AlgoStatus.Running && _vwapMode == "realtime"
            && Math.Abs(_deviationFromVwap) > _maxDeviationBps)
        {
            Status = AlgoStatus.Paused;
            _pauseReason = $"VWAP deviation {_deviationFromVwap:F0}bps";
            return;
        }

        // Auto-resume
        if (Status == AlgoStatus.Paused && _pauseReason != "manual")
        {
            var devOk = _vwapMode != "realtime"
                || Math.Abs(_deviationFromVwap) <= _maxDeviationBps;
            if (devOk)
            {
                Status = AlgoStatus.Running;
                _pauseReason = null;
            }
        }

        if (Status != AlgoStatus.Running) return;
        if (IsComplete()) { Status = AlgoStatus.Completed; OnCompleted(); return; }
        if (now >= _endTs) { await Sweep(bid, ask, now); return; }
        if (Status == AlgoStatus.Completing)
        {
            if (now > _completingDeadline)
            {
                Status = AlgoStatus.Completed;
                OnCompleted();
            }
            return;
        }

        await CheckChase(bid, ask, now);

        if (_restingClientOrderId == null && now >= _nextSliceAt
            && RemainingSize > 0.001m && _slicesFired < _slicesTotal)
        {
            var canFire = _vwapMode == "realtime" ? _inParticipationBand : true;
            if (canFire) await FireSlice(bid, ask, mid);
        }
    }

    // ── _sweep ────────────────────────────────────────────────────────────
    private async Task Sweep(decimal bid, decimal ask, long now)
    {
        if (_restingClientOrderId != null)
        {
            try { await Orders.CancelAsync(Params.Exchange, _restingClientOrderId); } catch { }
            PendingOrders.Remove(_restingClientOrderId);
            _restingClientOrderId = null;
        }

        if (RemainingSize > 0.001m && bid > 0 && ask > 0)
        {
            var tick = Params.TickSize;
            var sweepPrice = RoundToTick(IsBuy() ? ask + tick : bid - tick);
            var clientId = NewClientOrderId();
            await SubmitOrderAsync(new OrderIntent(
                StrategyId, clientId, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", RoundToLot(RemainingSize), sweepPrice, null, "IOC",
                Tag: "sweep"));
            _restingClientOrderId = clientId;
            _restingPrice = sweepPrice;
            Status = AlgoStatus.Completing;
            _completingDeadline = now + 10_000;
        }
        else
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
        }
    }

    // ── _checkChase ───────────────────────────────────────────────────────
    private async Task CheckChase(decimal bid, decimal ask, long now)
    {
        if (_restingClientOrderId == null || bid <= 0 || ask <= 0) return;

        var rp = _restingPrice;
        var tick = Params.TickSize;
        var moved = IsBuy()
            ? bid < rp - tick
            : ask > rp + tick;
        var back = IsBuy()
            ? bid >= rp
            : ask <= rp;

        if (moved && _chaseAt == 0)
        {
            _chaseAt = now + (long)Rand(3000, 7000);
        }
        else if (back)
        {
            _chaseAt = 0;
        }

        if (_chaseAt > 0 && now >= _chaseAt)
        {
            try { await Orders.CancelAsync(Params.Exchange, _restingClientOrderId); } catch { }
            PendingOrders.Remove(_restingClientOrderId);
            _restingClientOrderId = null;
            _restingPrice = 0;
            _chaseAt = 0;
        }
    }

    // ── _fireSlice ────────────────────────────────────────────────────────
    private async Task FireSlice(decimal bid, decimal ask, decimal mid)
    {
        if (mid <= 0) return;

        _slicesFired++;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var size = RemainingSize / Math.Max(1, _slicesTotal - _slicesFired + 1);

        // Historical mode: apply U-shaped profile weight
        if (_vwapMode == "historical" && _startTs > 0 && _endTs > 0)
        {
            var elapsed = (decimal)(now - _startTs) / (_endTs - _startTs);
            _profileWeight = ProfileWeight(Math.Clamp(elapsed, 0, 1));
            size *= _profileWeight;
        }

        // Benchmark mode: auto-adjust urgency based on slippage
        if (_vwapMode == "benchmark" && _rollingVwap > 0 && AvgFillPrice > 0)
        {
            var dir = IsBuy() ? 1m : -1m;
            var slip = (AvgFillPrice - _rollingVwap) / _rollingVwap * 10_000m * dir;
            _currentUrgency = slip > 5 ? "aggressive" : slip > 0 ? "neutral" : _baseUrgency;
        }

        var urg = _vwapMode == "benchmark" ? _currentUrgency : _baseUrgency;

        size = Math.Max(_lotSize, Math.Min(RoundToLot(size), RemainingSize));

        var tick = Params.TickSize;
        decimal price;
        if (urg == "passive")
            price = IsBuy() ? bid : ask;
        else if (urg == "aggressive")
            price = IsBuy() ? ask + tick : bid - tick;
        else
            price = mid;

        if (price <= 0) price = mid;
        price = RoundToTick(price);

        // Hard limit check
        if (_limitMode == "hard_limit" && _limitPrice > 0)
        {
            if (IsBuy() && price > _limitPrice) return;
            if (!IsBuy() && price < _limitPrice) return;
        }

        var tif = urg == "aggressive" ? "IOC" : urg == "passive" ? "GTC" : "GTC";
        var postOnly = urg == "passive";
        var clientId = NewClientOrderId();

        await SubmitOrderAsync(new OrderIntent(
            StrategyId, clientId, Params.Exchange, Params.Symbol,
            Params.Side.ToUpper(), "LIMIT", size, price, null, tif,
            PostOnly: postOnly, Tag: $"vwap_{_slicesFired}"));

        _restingClientOrderId = clientId;
        _restingPrice = price;
        _chaseAt = 0;

        Logger.LogInformation("[VWAP] {Sid} slice {N}/{T}: {Sz} @ {Px} urgency={Urg}",
            StrategyId, _slicesFired, _slicesTotal, size, price, urg);

        // Schedule next slice with variance jitter
        var jitter = 1.0 + Rand(-(double)_variancePct / 100.0, (double)_variancePct / 100.0);
        _nextSliceAt = now + (long)(_intervalMs * jitter);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnFillReceived — translation of _onFillExtended
    // ═══════════════════════════════════════════════════════════════════════
    protected override void OnFillReceived(AlgoFill fill)
    {
        // Slippage vs VWAP
        if (_rollingVwap > 0)
        {
            var dir = IsBuy() ? 1m : -1m;
            _slippageVsVwap = (AvgFillPrice - _rollingVwap) / _rollingVwap * 10_000m * dir;
        }

        _restingClientOrderId = null;
        _restingPrice = 0;
        _chaseAt = 0;

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
        if (clientOrderId != _restingClientOrderId) return;

        _restingClientOrderId = null;
        _restingPrice = 0;
        _chaseAt = 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Status hooks
    // ═══════════════════════════════════════════════════════════════════════
    protected override int GetCurrentSlice() => _slicesFired;
    protected override int GetTotalSlices() => _slicesTotal;
    protected override long? GetNextSliceAt() => _nextSliceAt;
    protected override string? GetPauseReason() => _pauseReason;

    protected override string? GetSummaryLine()
        => $"{Params.Side} {Params.TotalSize} {Params.Symbol} on {Params.Exchange} via VWAP | " +
           $"{_vwapMode} | {_currentUrgency} | {_durationMs / 60_000}min | {_slicesTotal} slices";

    // ═══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════
    private bool IsBuy() => Params.Side.ToUpper() == "BUY";

    private bool IsComplete() => RemainingSize <= Params.LotSize / 2;

    private static double Rand(double min, double max) => _rng.NextDouble() * (max - min) + min;

    private static decimal ProfileWeight(decimal pct)
        => 0.5m + 1.0m * (decimal)Math.Pow((double)(2 * Math.Abs(pct - 0.5m)), 2);
}
