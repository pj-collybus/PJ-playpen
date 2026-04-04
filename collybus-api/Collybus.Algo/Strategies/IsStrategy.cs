using Collybus.Algo.Models;
using Collybus.Algo.Ports;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

/// <summary>
/// IS — Implementation Shortfall execution strategy.
/// Faithful translation of the TypeScript ISStrategy class.
/// Minimises total implementation shortfall (timing cost + market impact)
/// by dynamically adjusting participation rate based on estimated volatility
/// and risk aversion.
/// </summary>
public class IsStrategy : BaseStrategy
{
    public override string StrategyType => "IS";

    private static readonly Dictionary<string, double> BiasMult = new()
    {
        ["risk_averse"] = 2.0,
        ["balanced"] = 1.0,
        ["cost_averse"] = 0.5
    };

    // ── Public state (mirrors TS public fields) ───────────────────────────
    private decimal _decisionPrice;
    private decimal _currentVwap;
    private decimal _estimatedVolatility;
    private decimal _optimalRate = 0.5m;
    private string _currentUrgency;
    private decimal _timingCost;
    private decimal _marketImpactCost;
    private decimal _totalIsCost;
    private int _slicesFired;
    private long _nextSliceAt;

    // ── Private configuration ─────────────────────────────────────────────
    private string _urgencyBias;
    private string _baseUrgency;
    private decimal _riskAversion;
    private long _volLookbackMs;
    private decimal _impactCoeff;
    private string _limitMode;
    private decimal _limitPrice;
    private decimal _lotSize;
    private long _durationMs;

    // ── Private runtime state ─────────────────────────────────────────────
    private readonly List<double> _priceReturns = new();
    private decimal _prevMid;
    private decimal _vwapNotional;
    private decimal _vwapVolume;
    private long _chaseAt;
    private long _completingDeadline;
    private long _endTs;

    // Active child order tracking
    private string? _activeChildId;
    private decimal? _restingPrice;
    private bool _placing;

    private static readonly Random _rng = new();

    public IsStrategy(string strategyId, ILogger<IsStrategy> logger)
        : base(strategyId, logger)
    {
        _urgencyBias = "balanced";
        _baseUrgency = "neutral";
        _currentUrgency = "neutral";
        _limitMode = "none";
    }

    // ── OnActivateAsync — mirrors TS constructor + _onActivate ────────────
    protected override Task OnActivateAsync()
    {
        var p = Params;

        _urgencyBias = p.UrgencyBias ?? "balanced";
        _baseUrgency = p.Urgency ?? "neutral";
        _currentUrgency = _baseUrgency;
        _riskAversion = p.RiskAversion ?? 0.5m;
        _volLookbackMs = (long)(p.VolatilityLookbackMinutes ?? 10) * 60_000L;
        _impactCoeff = p.MarketImpactCoeff ?? 0.1m;
        _limitMode = p.LimitMode ?? "none";
        _limitPrice = p.LimitPrice ?? 0;
        _lotSize = p.LotSize;
        _durationMs = (long)(p.DurationMinutes ?? 30) * 60_000L;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _endTs = now + _durationMs;

        var mid = CurrentMid;
        if (mid > 0) _decisionPrice = mid;

        _nextSliceAt = now;
        Status = AlgoStatus.Running;

        Logger.LogInformation(
            "[IS] {Sid} activated: side={Side} total={Total} symbol={Symbol} exchange={Exchange} " +
            "urgencyBias={UrgencyBias} riskAversion={RiskAversion} duration={Dur}ms " +
            "limitMode={LimitMode} limitPrice={LimitPrice}",
            StrategyId, p.Side, p.TotalSize, p.Symbol, p.Exchange,
            _urgencyBias, _riskAversion, _durationMs,
            _limitMode, _limitPrice);

        return Task.CompletedTask;
    }

    // ── OnMarketData — accumulate VWAP from trade data (mirrors TS onTrade) ─
    public override void OnMarketData(MarketDataPoint data)
    {
        base.OnMarketData(data);

        if (data.LastTradeSize <= 0) return;
        _vwapNotional += data.LastTrade * data.LastTradeSize;
        _vwapVolume += data.LastTradeSize;
        _currentVwap = _vwapVolume > 0 ? _vwapNotional / _vwapVolume : 0;
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

        if (_decisionPrice == 0 && mid > 0) _decisionPrice = mid;

        // Completing state
        if (Status == AlgoStatus.Completing)
        {
            if (now > _completingDeadline || _activeChildId == null)
            {
                Status = AlgoStatus.Completed;
                OnCompleted();
            }
            return;
        }

        // End of window — sweep
        if (now >= _endTs && (Status == AlgoStatus.Running || Status == AlgoStatus.Paused))
        {
            await Sweep(bid, ask, now);
            return;
        }

        UpdateVolatility(mid);
        UpdateISCosts(mid);
        CalcOptimalRate();

        if (Status != AlgoStatus.Running) return;

        if (IsComplete())
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
            return;
        }

        await CheckChase(bid, ask, now);

        if (_activeChildId == null && !_placing && now >= _nextSliceAt && RemainingSize > 0.001m)
        {
            await FireSlice(bid, ask, mid);
        }
    }

    // ── _updateVolatility ─────────────────────────────────────────────────
    private void UpdateVolatility(decimal mid)
    {
        if (mid > 0 && _prevMid > 0)
        {
            var ret = (double)((mid - _prevMid) / _prevMid);
            _priceReturns.Add(ret);
            var max = (int)Math.Round((double)_volLookbackMs / 1000.0);
            while (_priceReturns.Count > max) _priceReturns.RemoveAt(0);
            if (_priceReturns.Count >= 5)
            {
                var n = _priceReturns.Count;
                var mean = _priceReturns.Sum() / n;
                var variance = _priceReturns.Sum(v => (v - mean) * (v - mean)) / n;
                _estimatedVolatility = (decimal)(Math.Sqrt(variance) * Math.Sqrt(3600.0));
            }
        }
        _prevMid = mid;
    }

    // ── _updateISCosts ────────────────────────────────────────────────────
    private void UpdateISCosts(decimal mid)
    {
        if (_decisionPrice <= 0 || mid <= 0) return;
        var dir = IsBuy() ? 1m : -1m;
        _timingCost = (mid - _decisionPrice) / _decisionPrice * 10_000m * dir;
        if (FilledSize > 0 && AvgFillPrice > 0)
            _marketImpactCost = (AvgFillPrice - _decisionPrice) / _decisionPrice * 10_000m * dir;
        _totalIsCost = _timingCost + _marketImpactCost;
    }

    // ── _calcOptimalRate ──────────────────────────────────────────────────
    private void CalcOptimalRate()
    {
        if (_estimatedVolatility > 0)
        {
            var biasMultVal = BiasMult.TryGetValue(_urgencyBias, out var bm) ? bm : 1.0;
            var lambda = (double)_riskAversion * biasMultVal;
            var vol = (double)_estimatedVolatility;
            var raw = Math.Sqrt(lambda * vol * vol / (2.0 * (double)_impactCoeff));
            _optimalRate = (decimal)Math.Clamp(raw, 0.05, 0.95);
        }
        _currentUrgency = _optimalRate < 0.25m ? "passive" : _optimalRate > 0.60m ? "aggressive" : "neutral";
    }

    // ── _sweep ────────────────────────────────────────────────────────────
    private async Task Sweep(decimal bid, decimal ask, long now)
    {
        if (_activeChildId != null)
        {
            try { await Orders.CancelAsync(Params.Exchange, _activeChildId); } catch { }
            PendingOrders.Remove(_activeChildId);
            _activeChildId = null;
        }

        if (RemainingSize > 0.001m && bid > 0 && ask > 0)
        {
            if (_placing) return;
            var tick = Params.TickSize;
            var sweepPrice = RoundToTick(IsBuy() ? ask + tick : bid - tick);
            var clientId = NewClientOrderId();
            _placing = true;
            try
            {
                await SubmitOrderAsync(new OrderIntent(
                    StrategyId, clientId, Params.Exchange, Params.Symbol,
                    Params.Side.ToUpper(), "LIMIT", RoundToLot(RemainingSize), sweepPrice, null, "IOC",
                    Tag: "sweep"));
                _activeChildId = clientId;
            }
            finally { _placing = false; }
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
        if (_activeChildId == null || bid <= 0 || ask <= 0) return;
        var rp = _restingPrice ?? 0;
        var tick = Params.TickSize;
        var moved = IsBuy() ? bid < rp - tick : ask > rp + tick;
        var back = IsBuy() ? bid >= rp : ask <= rp;

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
            try { await Orders.CancelAsync(Params.Exchange, _activeChildId); } catch { }
            PendingOrders.Remove(_activeChildId);
            _activeChildId = null;
            _restingPrice = null;
            _chaseAt = 0;
        }
    }

    // ── _fireSlice ────────────────────────────────────────────────────────
    private async Task FireSlice(decimal bid, decimal ask, decimal mid)
    {
        if (mid <= 0) return;
        _slicesFired++;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var elapsed = 1.0m - ((decimal)Math.Max(1000, _endTs - now) / (decimal)(_endTs - StartedAt));
        var effectiveRate = _slicesFired == 1 ? Math.Min(_optimalRate, 0.5m) : _optimalRate;
        var minSlices = Math.Max(5, (int)Math.Round((double)(Params.TotalSize / (_lotSize * 5))));
        var size = Params.TotalSize / minSlices * Math.Max(0.1m, effectiveRate * 2);

        if (elapsed < 0.5m) size = Math.Min(size, Params.TotalSize / 5);
        if (RemainingSize > _lotSize * 2) size = Math.Min(size, RemainingSize / 2);
        size = Math.Max(_lotSize, Math.Min(RoundToLot(size), RemainingSize));

        var tick = Params.TickSize;
        decimal price;
        if (_currentUrgency == "passive")
            price = IsBuy() ? bid : ask;
        else if (_currentUrgency == "aggressive")
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

        var tif = _currentUrgency == "aggressive" ? "IOC" : "GTC";
        var postOnly = _currentUrgency == "passive";

        if (_placing) return;
        var clientId = NewClientOrderId();
        _placing = true;
        try
        {
            await SubmitOrderAsync(new OrderIntent(
                StrategyId, clientId, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", size, price, null, tif,
                PostOnly: postOnly, Tag: $"slice_{_slicesFired}"));
            _activeChildId = clientId;
            _restingPrice = price;
            _chaseAt = 0;
        }
        finally { _placing = false; }

        Logger.LogInformation("[IS] {Sid} slice {N}: {Sz} @ {Px} urgency={Urgency} optRate={Rate}",
            StrategyId, _slicesFired, size, price, _currentUrgency, _optimalRate);

        // Schedule next slice
        var interval = (long)Math.Max(5000, 60_000.0 / Math.Max(0.1, (double)_optimalRate));
        var jitter = 1.0 + (Rand(-0.1, 0.1));
        _nextSliceAt = now + (long)(interval * jitter);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnFillReceived — translation of _onFillExtended
    // ═══════════════════════════════════════════════════════════════════════
    protected override void OnFillReceived(AlgoFill fill)
    {
        if (_decisionPrice > 0)
        {
            var dir = IsBuy() ? 1m : -1m;
            _marketImpactCost = (AvgFillPrice - _decisionPrice) / _decisionPrice * 10_000m * dir;
            _totalIsCost = _timingCost + _marketImpactCost;
        }

        _activeChildId = null;
        _restingPrice = null;
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
        if (clientOrderId != _activeChildId) return;

        _activeChildId = null;
        _restingPrice = null;
        _chaseAt = 0;

        if (Status == AlgoStatus.Completing)
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Status hooks — translation of _strategyState
    // ═══════════════════════════════════════════════════════════════════════
    protected override int GetCurrentSlice() => _slicesFired;
    protected override int GetTotalSlices() => 0; // IS does not have a fixed total
    protected override long? GetNextSliceAt() => _nextSliceAt;
    protected override string? GetPauseReason() => null;

    protected override string? GetSummaryLine()
    {
        var biasLabel = _urgencyBias;
        var durMin = Params.DurationMinutes ?? 30;
        return $"{Params.Side} {Params.TotalSize} {Params.Symbol} on {Params.Exchange} via IS | " +
               $"{biasLabel} | {durMin} min";
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════
    private bool IsBuy() => Params.Side.ToUpper() == "BUY";

    private bool IsComplete() => RemainingSize <= Params.LotSize / 2;

    private static double Rand(double min, double max) => _rng.NextDouble() * (max - min) + min;

    protected override void PopulateStrategyState(AlgoStatusReport report)
    {
        RestingPrice = _restingPrice > 0 ? _restingPrice : null;
        report.IsCostBps = _totalIsCost;
        report.TimingCostBps = _timingCost;
        report.ImpactCostBps = _marketImpactCost;
        report.OptimalRate = _optimalRate;
        report.EstimatedVolatility = _estimatedVolatility;
        report.CurrentUrgency = _currentUrgency;
        report.Urgency = _currentUrgency;
        report.ChartTargetPrice = _decisionPrice > 0 ? _decisionPrice : null;
    }
}
