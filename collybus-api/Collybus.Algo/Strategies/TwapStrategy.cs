using Collybus.Algo.Models;
using Collybus.Algo.Ports;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

/// <summary>
/// TWAP — Time-Weighted Average Price execution strategy.
/// Faithful translation of the TypeScript TWAPStrategy class.
/// Executes total size evenly over a duration with urgency modes (passive / balanced / aggressive),
/// chase logic, passive-cross escalation, end-of-window escalation, average-rate limiting,
/// and final sweep.
/// </summary>
public class TwapStrategy : BaseStrategy
{
    public override string StrategyType => "TWAP";

    // ── Public slice state (mirrors TS public fields) ──────────────────────
    private int _slicesFired;
    private int _slicesTotal;
    private long _nextSliceAt;
    private decimal _rollingVwap;
    private decimal _slippageVsVwap;

    // ── Private configuration (set once in constructor / OnActivateAsync) ──
    private string _durationMode = "minutes";
    private int _durationMin;
    private string _endTimeStr = "";
    private string _amountMode = "base";
    private decimal _rawSize;
    private string _slicesMode = "auto";
    private int _manualSlices;
    private decimal _variancePct;
    private string _limitMode = "none";
    private decimal _limitPrice;
    private decimal _averageRateLimit;
    private string _urgency = "passive";

    // ── Private runtime state ──────────────────────────────────────────────
    private long _intervalMs;
    private decimal _rollingVwapNot;
    private decimal _rollingVwapQty;
    private long _chaseDeadline;
    private long _completingDeadline;
    private long _retryAt;
    private decimal _retrySliceSize;
    private int _rejectCount;
    private long _sliceStartTs;
    private long _sliceDeadlineTs;
    private bool _sliceCrossed;

    private long _endTs;
    private long _startTs;

    // Active child order tracking
    private string? _restingClientOrderId;
    private decimal _restingPrice;
    private bool _placing;

    // Cancel-then-aggress guards + IOC timeout
    private bool _waitingForCancelConfirm;
    private bool _shouldAggressAfterCancel;
    private long _cancelSentAt;
    private long _orderPlacedAt;

    // Spread threshold
    private decimal _maxSpreadBps;

    // Pause reason
    private string? _pauseReason;

    private static readonly Random _rng = new();

    public TwapStrategy(string strategyId, ILogger<TwapStrategy> logger)
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

        // Constructor-equivalent reads from params
        _durationMode = "minutes"; // params.durationMode || 'minutes' — AlgoParams has no durationMode, default
        _durationMin = p.DurationMinutes ?? 30;
        _endTimeStr = ""; // params.endTime || '' — not in AlgoParams
        _amountMode = "base"; // params.amountMode || 'base' — not in AlgoParams
        _rawSize = p.TotalSize;
        _slicesMode = p.NumSlices.HasValue ? "manual" : "auto";
        _manualSlices = p.NumSlices ?? 10;
        _variancePct = (decimal)(p.ScheduleVariancePct ?? 10);
        _limitMode = p.LimitMode ?? "none";
        _limitPrice = p.LimitPrice ?? 0;
        _averageRateLimit = 0; // params.averageRateLimit — not in AlgoParams
        _urgency = p.Urgency ?? "passive";
        _maxSpreadBps = p.MaxSpreadBps ?? 50;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _startTs = now;

        // Terms mode: convert USD amount to base using arrival price
        // (AlgoParams.TotalSize is already set, but we honour the TS logic)
        var arrivalPrice = p.ArrivalMid > 0 ? p.ArrivalMid : (p.ArrivalBid + p.ArrivalAsk) / 2;
        if (_amountMode == "terms" && arrivalPrice > 0)
        {
            // Would mutate totalSize; in C# TotalSize is on the record so we leave as-is.
            // _rawSize is kept for reference.
        }

        // Calculate end time
        if (_durationMode == "until_time")
        {
            // parseTime not available — fall through to minutes-based
            _endTs = now + (long)_durationMin * 60_000L;
        }
        else
        {
            _endTs = now + (long)_durationMin * 60_000L;
        }

        var durationMs = _endTs - now;

        _slicesTotal = _slicesMode == "auto"
            ? Math.Max(2, Math.Min(500, (int)Math.Round((double)durationMs / 60_000.0)))
            : Math.Max(2, Math.Min(500, _manualSlices));

        _intervalMs = durationMs / _slicesTotal;
        _nextSliceAt = now;
        Status = AlgoStatus.Running;

        Logger.LogInformation(
            "[TWAP] {Sid} activated: side={Side} total={Total} symbol={Symbol} exchange={Exchange} " +
            "urgency={Urgency} duration={Dur}min slices={Slices} interval={Interval}ms " +
            "limitMode={LimitMode} limitPrice={LimitPrice} variancePct={Var} maxSpread={MaxSpread}bps",
            StrategyId, p.Side, p.TotalSize, p.Symbol, p.Exchange,
            _urgency, _durationMin, _slicesTotal, _intervalMs,
            _limitMode, _limitPrice, _variancePct, _maxSpreadBps);

        return Task.CompletedTask;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnTickAsync — exact translation of _onTick
    // ═══════════════════════════════════════════════════════════════════════
    public override async Task OnTickAsync()
    {
        if (CurrentBid <= 0 || CurrentAsk <= 0) return; // wait for market data
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var bid = CurrentBid;
        var ask = CurrentAsk;
        var mid = CurrentMid;

        // Change 1+3: Block while waiting for cancel confirmation, with 5s timeout
        if (_waitingForCancelConfirm)
        {
            if (_cancelSentAt > 0 && now - _cancelSentAt > 5000)
            {
                Logger.LogWarning("[TWAP] {Sid} cancel timeout — force clear", StrategyId);
                _waitingForCancelConfirm = false;
                _shouldAggressAfterCancel = false;
                PendingOrders.Remove(_restingClientOrderId ?? "");
                _restingClientOrderId = null;
                _restingPrice = 0;
            }
            else return;
        }

        CheckAverageRateLimit();
        AutoResume(mid);

        if (Status != AlgoStatus.Running) return;
        if (IsComplete()) { Status = AlgoStatus.Completed; OnCompleted(); return; }

        // IOC timeout: if resting order is stale (IOC cancelled with no confirmation), clear after 5s
        if (_restingClientOrderId != null && _orderPlacedAt > 0
            && now - _orderPlacedAt > 5000
            && _urgency == "aggressive")
        {
            Logger.LogWarning("[TWAP] {Sid} IOC timeout — clearing stale order", StrategyId);
            PendingOrders.Remove(_restingClientOrderId);
            _restingClientOrderId = null;
            _orderPlacedAt = 0;
            _restingPrice = 0;
        }

        if (await CheckWindowEnd(bid, ask, now)) return;
        if (CheckCompleting(now)) return;
        await CheckPassiveCross(bid, ask, now);
        await CheckChase(bid, ask, now);
        await CheckEscalation(now);
        await CheckRetryOrSchedule(bid, ask, mid, now);
    }

    // ── _checkAverageRateLimit ─────────────────────────────────────────────
    private void CheckAverageRateLimit()
    {
        if (Status != AlgoStatus.Running) return;
        if (_limitMode == "average_rate" && _averageRateLimit > 0 && AvgFillPrice > 0)
        {
            var breached = IsBuy()
                ? AvgFillPrice > _averageRateLimit
                : AvgFillPrice < _averageRateLimit;
            if (breached)
            {
                Status = AlgoStatus.Paused;
                _pauseReason = "Avg rate breached limit";
            }
        }
    }

    // ── _autoResume ────────────────────────────────────────────────────────
    private void AutoResume(decimal mid)
    {
        if (Status == AlgoStatus.Paused && _pauseReason != "manual")
        {
            var spreadOk = mid == 0 || CurrentSpreadBps <= _maxSpreadBps;
            if (spreadOk)
            {
                Status = AlgoStatus.Running;
                _pauseReason = null;
            }
        }
    }

    // ── _checkWindowEnd ────────────────────────────────────────────────────
    private async Task<bool> CheckWindowEnd(decimal bid, decimal ask, long now)
    {
        if (now < _endTs || (Status != AlgoStatus.Running && Status != AlgoStatus.Paused))
            return false;

        if (_restingClientOrderId != null)
        {
            try { await Orders.CancelAsync(Params.Exchange, _restingClientOrderId); } catch { }
            PendingOrders.Remove(_restingClientOrderId);
            _restingClientOrderId = null;
            _chaseDeadline = 0;
        }

        if (RemainingSize > 0 && bid > 0 && ask > 0)
        {
            if (_restingClientOrderId != null || _placing) return true;
            var tick = Params.TickSize;
            var sweepPrice = RoundToTick(IsBuy() ? ask + tick : bid - tick);
            var clientId = NewClientOrderId();
            _restingClientOrderId = clientId;
            _placing = true;
            try
            {
                await SubmitOrderAsync(new OrderIntent(
                    StrategyId, clientId, Params.Exchange, Params.Symbol,
                    Params.Side.ToUpper(), "LIMIT", RoundToLot(RemainingSize), sweepPrice, null, "IOC",
                    Tag: "sweep"));
            }
            catch
            {
                _restingClientOrderId = null;
                throw;
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

        return true;
    }

    // ── _checkCompleting ───────────────────────────────────────────────────
    private bool CheckCompleting(long now)
    {
        if (Status != AlgoStatus.Completing) return false;
        if (IsComplete() || now > _completingDeadline)
        {
            Console.WriteLine($"[twap] completing→completed: filled={FilledSize}/{Params.TotalSize} remaining={RemainingSize} timedOut={now > _completingDeadline}");
            Status = AlgoStatus.Completed;
            OnCompleted();
            try { _ = Events.PublishStatusAsync(GetStatus()); } catch { }
        }
        return true;
    }

    // ── _checkPassiveCross ─────────────────────────────────────────────────
    private async Task CheckPassiveCross(decimal bid, decimal ask, long now)
    {
        if (_urgency != "passive" || _restingClientOrderId == null || _sliceCrossed) return;
        if (_sliceDeadlineTs <= 0 || now < _sliceDeadlineTs || bid <= 0 || ask <= 0) return;

        try { await Orders.CancelAsync(Params.Exchange, _restingClientOrderId); } catch { }
        PendingOrders.Remove(_restingClientOrderId);
        _restingClientOrderId = null;
        _sliceCrossed = true;

        var tick = Params.TickSize;
        var crossPrice = RoundToTick(IsBuy() ? ask + tick : bid - tick);
        var crossQty = RoundToLot(Math.Min(RemainingSize, Params.TotalSize / Math.Max(1, _slicesTotal)));
        if (crossQty > 0.001m)
        {
            if (_restingClientOrderId != null || _placing) return;
            var clientId = NewClientOrderId();
            _restingClientOrderId = clientId;
            _restingPrice = crossPrice;
            _orderPlacedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _placing = true;
            try
            {
                await SubmitOrderAsync(new OrderIntent(
                    StrategyId, clientId, Params.Exchange, Params.Symbol,
                    Params.Side.ToUpper(), "LIMIT", crossQty, crossPrice, null, "IOC",
                    Tag: "passive_cross"));
            }
            catch
            {
                _restingClientOrderId = null;
                _restingPrice = 0;
                _orderPlacedAt = 0;
                throw;
            }
            finally { _placing = false; }
        }
    }

    // ── _checkChase ────────────────────────────────────────────────────────
    private async Task CheckChase(decimal bid, decimal ask, long now)
    {
        if (_restingClientOrderId == null || bid <= 0 || ask <= 0) return;
        if (_urgency != "aggressive" && !_sliceCrossed) return;

        var rp = _restingPrice;
        var moved = IsBuy()
            ? bid > rp * 1.0001m
            : ask < rp * 0.9999m;

        if (moved && _chaseDeadline == 0)
        {
            _chaseDeadline = now + (long)Rand(3000, 7000);
        }
        else if (_chaseDeadline > 0 && now >= _chaseDeadline)
        {
            try { await Orders.CancelAsync(Params.Exchange, _restingClientOrderId); } catch { }
            PendingOrders.Remove(_restingClientOrderId);
            _restingClientOrderId = null;
            _chaseDeadline = 0;
        }
    }

    // ── _checkEscalation ───────────────────────────────────────────────────
    private async Task CheckEscalation(long now)
    {
        var timeRemaining = _endTs - now;
        var totalDuration = _endTs - _startTs;
        if (timeRemaining > 0 && timeRemaining < totalDuration * 0.1
            && RemainingSize > 0 && _urgency != "aggressive"
            && _restingClientOrderId != null)
        {
            try { await Orders.CancelAsync(Params.Exchange, _restingClientOrderId); } catch { }
            PendingOrders.Remove(_restingClientOrderId);
            _restingClientOrderId = null;
            _urgency = "aggressive";
            Logger.LogInformation("[TWAP] {Sid} escalating to aggressive (last 10%)", StrategyId);
        }
    }

    // ── _checkRetryOrSchedule ──────────────────────────────────────────────
    private async Task CheckRetryOrSchedule(decimal bid, decimal ask, decimal mid, long now)
    {
        if (_retryAt > 0 && now >= _retryAt && _restingClientOrderId == null && !_placing && RemainingSize > 0.001m)
        {
            _retryAt = 0;
            await FireSlice(bid, ask, mid, _retrySliceSize);
        }
        else if (now >= _nextSliceAt && _restingClientOrderId == null && !_placing && RemainingSize > 0.001m
                 && _retryAt == 0 && _slicesFired < _slicesTotal)
        {
            _rejectCount = 0;
            await FireSlice(bid, ask, mid);
        }
    }

    // ── _fireSlice ─────────────────────────────────────────────────────────
    private async Task FireSlice(decimal bid, decimal ask, decimal mid, decimal overrideSize = 0)
    {
        if (RemainingSize <= 0 || mid <= 0) return;

        _slicesFired++;

        var sliceSize = overrideSize > 0
            ? Math.Min(overrideSize, RemainingSize)
            : Math.Min(RemainingSize / Math.Max(1, _slicesTotal - _slicesFired + 1), RemainingSize);

        sliceSize = RoundToLot(sliceSize);
        if (sliceSize <= 0) { ScheduleNext(); return; }

        // Market limit check
        if (_limitMode == "market_limit" && _limitPrice > 0)
        {
            if (IsBuy() && mid > _limitPrice) { ScheduleNext(); return; }
            if (!IsBuy() && mid < _limitPrice) { ScheduleNext(); return; }
        }

        var tick = Params.TickSize;
        decimal price;
        string tif;
        bool postOnly = false;

        if (_urgency == "aggressive")
        {
            price = IsBuy() ? ask + tick : bid - tick;
            tif = "IOC";
        }
        else if (_urgency == "passive")
        {
            price = IsBuy() ? bid : ask;
            tif = "GTC";
            postOnly = true;
        }
        else
        {
            // balanced
            price = mid;
            tif = "GTC";
        }

        if (price <= 0) price = mid;
        price = RoundToTick(price);

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _sliceStartTs = now;
        _sliceDeadlineTs = now + (long)(_intervalMs * 0.8);
        _sliceCrossed = false;

        if (_restingClientOrderId != null || _placing) return;
        var clientId = NewClientOrderId();
        _restingClientOrderId = clientId;
        _restingPrice = price;
        _orderPlacedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _chaseDeadline = 0;
        _placing = true;
        try
        {
            await SubmitOrderAsync(new OrderIntent(
                StrategyId, clientId, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", sliceSize, price, null, tif,
                PostOnly: postOnly, Tag: $"slice_{_slicesFired}"));
        }
        catch
        {
            _restingClientOrderId = null;
            _restingPrice = 0;
            _orderPlacedAt = 0;
            throw;
        }
        finally { _placing = false; }

        Logger.LogInformation("[TWAP] {Sid} slice {N}/{T}: {Sz} @ {Px} {Tif}",
            StrategyId, _slicesFired, _slicesTotal, sliceSize, price, tif);

        ScheduleNext();
    }

    // ── _scheduleNext ──────────────────────────────────────────────────────
    private void ScheduleNext()
    {
        var jitter = 1.0 + Rand(-(double)_variancePct / 100.0, (double)_variancePct / 100.0);
        _nextSliceAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            + (long)(_intervalMs * jitter);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  OnFillReceived — translation of _onFillExtended
    // ═══════════════════════════════════════════════════════════════════════
    protected override void OnFillReceived(AlgoFill fill)
    {
        Console.WriteLine($"[twap] OnFill: fillSize={fill.FillSize} filledSize={FilledSize} totalSize={Params.TotalSize} remaining={RemainingSize} status={Status}");
        // cappedFill is the effective fill size (already capped by base class)
        var cappedFill = fill.FillSize;

        _rollingVwapNot += fill.FillPrice * cappedFill;
        _rollingVwapQty += cappedFill;
        _rollingVwap = _rollingVwapQty > 0 ? _rollingVwapNot / _rollingVwapQty : 0;

        if (_rollingVwap > 0)
        {
            var dir = IsBuy() ? 1m : -1m;
            _slippageVsVwap = (AvgFillPrice - _rollingVwap) / _rollingVwap * 10_000m * dir;
        }

        _restingClientOrderId = null;
        _chaseDeadline = 0;

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
        // Only handle if it matches the active child
        if (clientOrderId != _restingClientOrderId) return;

        Logger.LogInformation("[TWAP] {Sid} order {Reason}: {Cid} — clearing",
            StrategyId, reason, clientOrderId);

        if (Status == AlgoStatus.Completing)
        {
            _restingClientOrderId = null;
            Status = AlgoStatus.Completed;
            OnCompleted();
            return;
        }

        if (_slicesFired > 0) _slicesFired--;

        var remaining = RemainingSize;
        _retrySliceSize = remaining / Math.Max(1, _slicesTotal - _slicesFired);

        _restingClientOrderId = null;
        _restingPrice = 0;
        _orderPlacedAt = 0;
        _chaseDeadline = 0;
        _placing = false;
        _waitingForCancelConfirm = false;
        _shouldAggressAfterCancel = false;

        var lowerReason = (reason ?? "").ToLowerInvariant();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        if (lowerReason.Contains("insufficient") || lowerReason.Contains("balance") || lowerReason.Contains("margin"))
        {
            Status = AlgoStatus.Paused;
            _pauseReason = "Insufficient balance";
            _retryAt = 0;
            _rejectCount = 0;
        }
        else if (lowerReason.Contains("rate") || lowerReason.Contains("throttl"))
        {
            _retryAt = now + 5000;
            _rejectCount = 0;
        }
        else
        {
            _rejectCount++;
            if (_rejectCount >= 3)
            {
                Status = AlgoStatus.Paused;
                _pauseReason = "3 consecutive rejections";
                _retryAt = 0;
                _rejectCount = 0;
            }
            else
            {
                _retryAt = now + 2000;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Status hooks — translation of _strategyState
    // ═══════════════════════════════════════════════════════════════════════
    protected override int GetCurrentSlice() => _slicesFired;
    protected override int GetTotalSlices() => _slicesTotal;
    protected override long? GetNextSliceAt() => _nextSliceAt;
    protected override string? GetPauseReason() => _pauseReason;

    protected override string? GetSummaryLine()
        => $"{Params.Side} {Params.TotalSize} {Params.Symbol} on {Params.Exchange} via TWAP | " +
           $"{_urgency} | {_durationMin} min | {_slicesTotal} slices";

    protected override void PopulateStrategyState(AlgoStatusReport report)
    {
        RestingPrice = _restingPrice > 0 ? _restingPrice : null;
        report.Urgency = _urgency;
        report.RollingVwap = _rollingVwap > 0 ? _rollingVwap : null;
    }

    protected override void OnPause()
    {
        _restingClientOrderId = null; _restingPrice = 0; _placing = false;
        _waitingForCancelConfirm = false; _shouldAggressAfterCancel = false;
        _pauseReason = "manual";
    }

    protected override Task OnResumeAsync()
    {
        // Resume slice schedule from now
        _nextSliceAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _pauseReason = null;
        return Task.CompletedTask;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════
    private bool IsBuy() => Params.Side.ToUpper() == "BUY";

    private bool IsComplete() => RemainingSize <= Params.LotSize / 2;

    private static double Rand(double min, double max) => _rng.NextDouble() * (max - min) + min;
}
