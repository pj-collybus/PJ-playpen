using Collybus.Algo.Models;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

/// <summary>
/// ICEBERG — place one limit at _fixedPrice for _visibleSize.
/// When it fills, place another. Repeat until done.
/// Only randomisation: slice size ± bps variance.
/// </summary>
public class IcebergStrategy : BaseStrategy
{
    public override string StrategyType => "ICEBERG";

    private decimal _visibleSize;
    private decimal _sizeVariancePct;
    private decimal _fixedPrice;
    private long _minRefreshMs;
    private long _maxRefreshMs;
    private long _expiryTs;

    private long _refreshAt;
    private int _slicesFired;
    private int _slicesFilled;
    private int _detectionScore;
    private long _lastFillTs;
    private readonly List<long> _fillIntervals = new();

    private string? _activeClientOrderId;
    private volatile bool _placing;
    private string? _pauseReason;

    private static readonly Random _rng = new();

    public IcebergStrategy(string strategyId, ILogger<IcebergStrategy> logger)
        : base(strategyId, logger) { }

    protected override Task OnActivateAsync()
    {
        var p = Params;
        _visibleSize = p.VisibleSize ?? 10;
        _sizeVariancePct = p.VisibleVariancePct ?? 20;
        _fixedPrice = p.LimitPrice ?? 0;
        _minRefreshMs = p.RefreshDelayMs ?? 500;
        _maxRefreshMs = 3000;

        // Expiry
        var expiry = (p.Expiry ?? "GTC").ToUpperInvariant();
        if (expiry == "DAY")
            _expiryTs = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(1).AddSeconds(-1), TimeSpan.Zero).ToUnixTimeMilliseconds();
        else if (expiry == "GTD" && DateTimeOffset.TryParse(p.GtdDateTime ?? "", out var dto))
            _expiryTs = dto.ToUnixTimeMilliseconds();

        _refreshAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Status = AlgoStatus.Running;

        Logger.LogInformation("[ICEBERG] {Sid} activated: {Side} {Total} {Symbol} | {Vis}/slice @ {Price} | var={Var}%",
            StrategyId, p.Side, p.TotalSize, p.Symbol, _visibleSize, _fixedPrice, _sizeVariancePct);
        return Task.CompletedTask;
    }

    // ── Tick: the entire strategy ──────────────────────────────────────────
    public override async Task OnTickAsync()
    {
        if (Status != AlgoStatus.Running) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        if (_expiryTs > 0 && now >= _expiryTs)
        {
            _pauseReason = "Expired";
            await StopAsync();
            return;
        }

        if (RemainingSize <= Params.LotSize / 2) { Status = AlgoStatus.Completed; OnCompleted(); return; }
        if (_placing || _activeClientOrderId != null) return;
        if (now < _refreshAt) return;
        if (_fixedPrice <= 0) { _pauseReason = "No limit price"; return; }

        await PlaceSlice();
    }

    // ── Place one slice ────────────────────────────────────────────────────
    private async Task PlaceSlice()
    {
        if (_placing || _activeClientOrderId != null) return;
        _placing = true;
        try
        {
            // Size: visible ± random variance %
            var baseSize = _visibleSize;
            var maxPossibleSlice = baseSize * (1 + _sizeVariancePct / 100m);

            decimal size;
            if (RemainingSize <= maxPossibleSlice)
            {
                // Last slice — use exactly remaining so total fills completely
                size = RoundToLot(RemainingSize);
                if (size <= 0) size = RemainingSize; // sub-lot final slice
            }
            else
            {
                var varianceFraction = (decimal)_rng.NextDouble() * _sizeVariancePct / 100m;
                var sign = _rng.NextDouble() > 0.5 ? 1m : -1m;
                var rawSize = baseSize + sign * baseSize * varianceFraction;
                size = RoundToLot(rawSize);
                size = Math.Max(Params.LotSize, size);
                size = Math.Min(size, RemainingSize);
            }
            if (size <= 0) return;

            var price = RoundToTick(_fixedPrice);
            _slicesFired++;
            var clientId = NewClientOrderId();
            _activeClientOrderId = clientId;

            await SubmitOrderAsync(new OrderIntent(
                StrategyId, clientId, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", size, price, null, "GTC",
                Tag: $"iceberg_{_slicesFired}"));

            Logger.LogInformation("[ICEBERG] {Sid} slice {N}: {Size} @ {Price}",
                StrategyId, _slicesFired, size, price);
        }
        finally { _placing = false; }
    }

    // ── Fill: clear and schedule next ──────────────────────────────────────
    protected override void OnFillReceived(AlgoFill fill)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _slicesFilled++;
        _activeClientOrderId = null;

        // Detection scoring
        if (_lastFillTs > 0)
        {
            _fillIntervals.Add(now - _lastFillTs);
            if (_fillIntervals.Count > 10) _fillIntervals.RemoveAt(0);
            UpdateDetectionScore();
        }
        _lastFillTs = now;

        // Schedule next slice
        _refreshAt = now + _minRefreshMs + (long)(_rng.NextDouble() * (_maxRefreshMs - _minRefreshMs));

        Logger.LogInformation("[ICEBERG] {Sid} fill #{N}: {Size}@{Price} — next in {Delay}ms at {Lim} remaining={Rem}",
            StrategyId, _slicesFilled, fill.FillSize, fill.FillPrice, _refreshAt - now, _fixedPrice, RemainingSize);
        // Completion is handled by BaseStrategy.OnFill after this returns
    }

    protected override void OnRejectionReceived(string clientOrderId, string reason)
    {
        if (clientOrderId != _activeClientOrderId) return;
        Logger.LogWarning("[ICEBERG] {Sid} slice rejected: {Reason} — retrying in 5s", StrategyId, reason);
        _activeClientOrderId = null;
        _placing = false;
        _refreshAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 5000;
        // Override base class auto-pause — Iceberg always retries
        if (Status == AlgoStatus.Paused)
        {
            Status = AlgoStatus.Running;
            _pauseReason = null;
            ConsecutiveRejections = 0;
        }
    }

    private void UpdateDetectionScore()
    {
        if (_fillIntervals.Count < 3) { _detectionScore = 0; return; }
        var intervals = _fillIntervals.GetRange(Math.Max(0, _fillIntervals.Count - 5), Math.Min(5, _fillIntervals.Count));
        double mean = 0; foreach (var v in intervals) mean += v; mean /= intervals.Count;
        if (mean == 0) { _detectionScore = 0; return; }
        double var2 = 0; foreach (var v in intervals) { var d = v - mean; var2 += d * d; } var2 /= intervals.Count;
        var cv = Math.Sqrt(var2) / mean;
        _detectionScore = (int)Math.Max(0, Math.Min(100, Math.Round(100.0 * (0.2 - cv) / 0.2)));
    }

    protected override int GetCurrentSlice() => _slicesFired;
    protected override int GetTotalSlices() => _slicesFired;
    protected override string? GetPauseReason() => _pauseReason;
    protected override string? GetSummaryLine()
    {
        var expiry = _expiryTs > 0 ? "GTD" : (Params.Expiry ?? "GTC");
        return $"{Params.Side} {Params.TotalSize} {Params.Symbol} on {Params.Exchange} via ICEBERG | {_visibleSize}±{_sizeVariancePct}%/slice @ {_fixedPrice} | {expiry}";
    }

    protected override void OnStop() { _activeClientOrderId = null; _placing = false; }
    protected override void OnPause()
    {
        _activeClientOrderId = null; _placing = false;
        _pauseReason = "manual";
    }
    protected override Task OnResumeAsync()
    {
        _pauseReason = null;
        _refreshAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); // re-place immediately
        return Task.CompletedTask;
    }

    protected override void PopulateStrategyState(AlgoStatusReport report)
    {
        RestingPrice = _fixedPrice > 0 ? _fixedPrice : null;
        report.VisibleSize = _visibleSize;
        report.DetectionRiskScore = _detectionScore;
        report.ActiveOrderPrice = _fixedPrice;
        report.Urgency = "passive";
    }
}
