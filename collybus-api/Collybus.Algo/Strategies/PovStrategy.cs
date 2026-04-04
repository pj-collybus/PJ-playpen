using Collybus.Algo.Models;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

/// <summary>
/// POV — Percentage of Volume execution strategy.
/// Faithful translation of the TypeScript POVStrategy class.
/// Tracks rolling market volume in a configurable window and fires child orders
/// to maintain a target participation rate, with urgency modes, limit checks,
/// catch-up logic, and auto-pause on volume drought.
/// </summary>
public class PovStrategy : BaseStrategy
{
    public override string StrategyType => "POV";

    // ── Public state (mirrors TS public fields) ───────────────────────────
    private decimal _windowVolume;
    private decimal _participationRate;

    // ── Private configuration ─────────────────────────────────────────────
    private decimal _targetPct;
    private int _volumeWindowSec;
    private decimal _minChildSize;
    private decimal _maxChildSize;
    private string _limitMode = "none";
    private decimal _limitPrice;
    private decimal _averageRateLimit;
    private string _urgency = "neutral";
    private string _endMode = "total_filled";
    private long _timeLimitMs;

    // ── Private runtime state ─────────────────────────────────────────────
    private readonly List<(decimal size, long ts)> _rollingVolume = new();
    private readonly List<(decimal size, long ts)> _myRollingFills = new();
    private decimal _myWindowVolume;
    private long _catchupTs;
    private long _lastTradeTs;
    private int _childCount;
    private long _endTs;

    // Active child order tracking
    private string? _activeClientOrderId;
    private decimal _restingPrice;
    private bool _placing;

    // Pause reason
    private string? _pauseReason;

    public PovStrategy(string strategyId, ILogger<PovStrategy> logger)
        : base(strategyId, logger)
    {
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnActivateAsync — constructor init + _onActivate
    // ═══════════════════════════════════════════════════════════════════════
    protected override Task OnActivateAsync()
    {
        var p = Params;

        _targetPct = p.ParticipationPct ?? 10m;
        _volumeWindowSec = p.VolumeWindowSeconds ?? 30;
        _minChildSize = p.MinChildSize ?? 0;
        _maxChildSize = p.MaxChildSize ?? 0;
        if (_minChildSize <= 0) _minChildSize = p.LotSize * 2;
        _limitMode = p.LimitMode ?? "none";
        _limitPrice = p.LimitPrice ?? 0;
        _averageRateLimit = 0; // params.averageRateLimit — not in AlgoParams
        _urgency = p.Urgency ?? "neutral";
        _endMode = "total_filled"; // params.endMode — not in AlgoParams
        _timeLimitMs = (p.DurationMinutes ?? 60) * 60_000L;

        // _onActivate
        if (_endMode == "time_limit")
            _endTs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + _timeLimitMs;

        Status = AlgoStatus.Running;

        Logger.LogInformation(
            "[POV] {Sid} activated: side={Side} total={Total} symbol={Symbol} exchange={Exchange} " +
            "targetPct={TargetPct}% window={Window}s urgency={Urgency} limitMode={LimitMode} limitPrice={LimitPrice}",
            StrategyId, p.Side, p.TotalSize, p.Symbol, p.Exchange,
            _targetPct, _volumeWindowSec, _urgency, _limitMode, _limitPrice);

        return Task.CompletedTask;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnMarketData — trade detection (replaces TS onTrade)
    // ═══════════════════════════════════════════════════════════════════════
    public override void OnMarketData(MarketDataPoint data)
    {
        base.OnMarketData(data);

        // Only process trade events
        if (data.LastTrade <= 0 || data.LastTradeSize <= 0) return;
        if (Status != AlgoStatus.Running) return;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _lastTradeTs = now;

        if (data.LastTradeSize <= 0) return;

        _rollingVolume.Add((data.LastTradeSize, now));
        ExpireVolume(now);

        var deficit = _windowVolume * (_targetPct / 100m) - _myWindowVolume;
        var minSz = Math.Max(_minChildSize, Params.LotSize);

        if (deficit < minSz || RemainingSize < minSz * 0.5m || _activeClientOrderId != null || _placing) return;

        var bid = CurrentBid;
        var ask = CurrentAsk;
        var mid = CurrentMid;
        if (mid <= 0) return;

        var sz = Math.Max(minSz, Math.Min(deficit, RemainingSize));
        if (_maxChildSize > 0) sz = Math.Min(sz, _maxChildSize);

        _ = FireChildAsync(sz, bid, ask, mid);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnTickAsync — translation of _onTick
    // ═══════════════════════════════════════════════════════════════════════
    public override async Task OnTickAsync()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var bid = CurrentBid;
        var ask = CurrentAsk;
        var mid = CurrentMid;

        // No-market-trades auto-pause
        if (Status == AlgoStatus.Running && _lastTradeTs > 0
            && now - _lastTradeTs > _volumeWindowSec * 2000L)
        {
            Status = AlgoStatus.Paused;
            _pauseReason = "No market volume detected";
            return;
        }

        // Auto-resume
        if (Status == AlgoStatus.Paused && _pauseReason != "manual")
        {
            var tradeOk = _lastTradeTs == 0 || now - _lastTradeTs <= _volumeWindowSec * 2000L;
            if (tradeOk)
            {
                Status = AlgoStatus.Running;
                _pauseReason = null;
            }
        }

        if (Status != AlgoStatus.Running) return;
        if (IsComplete()) { Status = AlgoStatus.Completed; OnCompleted(); return; }
        if (_endTs > 0 && now >= _endTs) { Status = AlgoStatus.Completed; OnCompleted(); return; }

        // Periodic catch-up every 5s
        if (now - _catchupTs >= 5000)
        {
            _catchupTs = now;
            ExpireVolume(now);

            var myTarget = _windowVolume * (_targetPct / 100m);
            var deficit = myTarget - _myWindowVolume;
            var minSz = Math.Max(_minChildSize, Params.LotSize);

            if (_activeClientOrderId == null && !_placing && RemainingSize > minSz * 0.5m)
            {
                if (_windowVolume > 0 && deficit >= minSz)
                {
                    await FireChildAsync(Math.Max(minSz, Math.Min(deficit, RemainingSize)), bid, ask, mid);
                }
                else if (_lastTradeTs > 0 && now - _lastTradeTs > _volumeWindowSec * 3000L)
                {
                    await FireChildAsync(
                        Math.Min(Math.Max(minSz, RemainingSize * 0.1m), RemainingSize),
                        bid, ask, mid);
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  FireChildAsync — translation of _fireChild
    // ═══════════════════════════════════════════════════════════════════════
    private async Task FireChildAsync(decimal size, decimal bid, decimal ask, decimal mid)
    {
        if (size <= 0 || RemainingSize <= 0 || mid <= 0) return;

        var tick = Params.TickSize;
        decimal price;

        if (_urgency == "passive")
            price = IsBuy() ? bid : ask;
        else if (_urgency == "aggressive")
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

        // Average rate limit check
        if (_limitMode == "average_rate" && _averageRateLimit > 0 && AvgFillPrice > 0)
        {
            var projAvg = (AvgFillPrice * FilledSize + price * size) / (FilledSize + size);
            if (IsBuy() && projAvg > _averageRateLimit) return;
            if (!IsBuy() && projAvg < _averageRateLimit) return;
        }

        if (_placing) return;
        _childCount++;
        size = RoundToLot(Math.Min(size, RemainingSize));
        if (size <= 0) return;

        var clientId = NewClientOrderId();
        _placing = true;
        try
        {
            await SubmitOrderAsync(new OrderIntent(
                StrategyId, clientId, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", size, price, null, "IOC",
                Tag: $"pov_child_{_childCount}"));
            _activeClientOrderId = clientId;
            _restingPrice = price;
        }
        finally { _placing = false; }

        Logger.LogInformation("[POV] {Sid} child #{N}: {Sz} @ {Px}",
            StrategyId, _childCount, size, price);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ExpireVolume — translation of _expireVolume
    // ═══════════════════════════════════════════════════════════════════════
    private void ExpireVolume(long now)
    {
        var cutoff = now - _volumeWindowSec * 1000L;

        while (_rollingVolume.Count > 0 && _rollingVolume[0].ts < cutoff)
            _rollingVolume.RemoveAt(0);

        while (_myRollingFills.Count > 0 && _myRollingFills[0].ts < cutoff)
            _myRollingFills.RemoveAt(0);

        _windowVolume = 0;
        foreach (var v in _rollingVolume) _windowVolume += v.size;

        _myWindowVolume = 0;
        foreach (var v in _myRollingFills) _myWindowVolume += v.size;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnFillReceived — translation of _onFillExtended
    // ═══════════════════════════════════════════════════════════════════════
    protected override void OnFillReceived(AlgoFill fill)
    {
        var cappedFill = fill.FillSize;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        _myRollingFills.Add((cappedFill, now));
        ExpireVolume(now);

        _participationRate = _windowVolume > 0
            ? (_myWindowVolume / _windowVolume) * 100m
            : 0m;

        _activeClientOrderId = null;
        _restingPrice = 0;

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
        _activeClientOrderId = null;
        _restingPrice = 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Status hooks — translation of _strategyState
    // ═══════════════════════════════════════════════════════════════════════
    protected override string? GetPauseReason() => _pauseReason;

    protected override string? GetSummaryLine()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var deficit = Math.Max(0m, _windowVolume * (_targetPct / 100m) - _myWindowVolume);
        return $"{Params.Side} {Params.TotalSize} {Params.Symbol} on {Params.Exchange} via POV | " +
               $"{_targetPct}% participation | {_volumeWindowSec}s window";
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════
    private bool IsBuy() => Params.Side.ToUpper() == "BUY";

    private bool IsComplete() => RemainingSize <= Params.LotSize / 2;

    protected override void PopulateStrategyState(AlgoStatusReport report)
    {
        RestingPrice = _activeClientOrderId != null ? (decimal?)null : null; // POV doesn't track resting price directly
        report.ParticipationRate = _participationRate;
        report.TargetParticipation = _targetPct;
        report.WindowVolume = _windowVolume;
        report.Deficit = Math.Max(0m, _windowVolume * (_targetPct / 100m) - _myWindowVolume);
        report.Urgency = _urgency;
    }
}
