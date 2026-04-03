using Collybus.Algo.Models;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

/// <summary>
/// VWAP — Volume-Weighted Average Price execution strategy.
/// Three modes: realtime (within band around VWAP), benchmark (auto-adjust urgency),
/// historical (U-shaped volume profile). Translated from vwap.js (470 lines).
/// </summary>
public class VwapStrategy : BaseStrategy
{
    public override string StrategyType => "VWAP";

    private long _endAt;
    private int _currentSlice;
    private int _numSlices;
    private decimal _sliceSize;
    private long _sliceIntervalMs;
    private long _nextSliceAt;
    private readonly Random _rng = new();
    private bool _pausedForDeviation;
    private long? _retryAt;

    private static readonly decimal[] HistoricalProfile =
    [
        1.8m, 1.6m, 1.4m, 1.2m, 1.0m, 0.9m, 0.8m, 0.8m,
        0.9m, 1.0m, 1.2m, 1.4m, 1.6m, 1.8m, 2.0m, 2.2m
    ];

    public VwapStrategy(string strategyId, ILogger<VwapStrategy> logger)
        : base(strategyId, logger) { }

    protected override Task OnActivateAsync()
    {
        var p = Params;
        var durationMs = (p.DurationMinutes ?? 10) * 60_000L;
        _endAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + durationMs;
        _numSlices = Math.Max(2, p.DurationMinutes ?? 10);
        _sliceIntervalMs = durationMs / _numSlices;
        _nextSliceAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _sliceSize = RoundToLot(Params.TotalSize / _numSlices);

        Logger.LogInformation("[VWAP] {Sid} started: mode={Mode} {Total} in {Slices} slices over {Dur}min",
            StrategyId, p.VwapMode, p.TotalSize, _numSlices, p.DurationMinutes);
        return Task.CompletedTask;
    }

    public override async Task OnTickAsync()
    {
        if (Status != AlgoStatus.Running) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        if (now >= _endAt) { await FinalSweepAsync(); return; }
        if (_retryAt.HasValue && now >= _retryAt.Value) { _retryAt = null; }
        if (now < _nextSliceAt || _currentSlice >= _numSlices || RemainingSize <= Params.LotSize / 2) return;

        switch (Params.VwapMode)
        {
            case "realtime": await ExecuteRealtimeAsync(); break;
            case "benchmark": await ExecuteBenchmarkAsync(); break;
            case "historical": await ExecuteHistoricalAsync(); break;
            default: await ExecuteSliceAsync("balanced"); break;
        }
    }

    private async Task ExecuteRealtimeAsync()
    {
        if (MarketVwap <= 0) { ScheduleNextSlice(); return; }

        var bandBps = Params.ParticipationBandBps ?? 20m;
        var bandWidth = MarketVwap * bandBps / 10000m;
        if (CurrentMid < MarketVwap - bandWidth || CurrentMid > MarketVwap + bandWidth)
        {
            ScheduleNextSlice(); return;
        }

        if (AvgFillPrice > 0 && Params.MaxDeviationBps.HasValue)
        {
            var devBps = Math.Abs(Tca.TcaCalculator.VwapShortfall(AvgFillPrice, MarketVwap, Params.Side));
            if (devBps > Params.MaxDeviationBps.Value)
            {
                if (!_pausedForDeviation)
                {
                    _pausedForDeviation = true;
                    Logger.LogInformation("[VWAP] {Sid} paused: deviation {Dev}bps > {Max}bps",
                        StrategyId, devBps, Params.MaxDeviationBps.Value);
                }
                ScheduleNextSlice(); return;
            }
        }
        _pausedForDeviation = false;
        await ExecuteSliceAsync(Params.Urgency ?? "balanced");
    }

    private async Task ExecuteBenchmarkAsync()
    {
        if (MarketVwap <= 0 || AvgFillPrice <= 0) { await ExecuteSliceAsync("balanced"); return; }
        var shortfall = Tca.TcaCalculator.VwapShortfall(AvgFillPrice, MarketVwap, Params.Side);
        var urgency = shortfall > 5m ? "aggressive" : shortfall < -5m ? "passive" : "balanced";
        await ExecuteSliceAsync(urgency);
    }

    private async Task ExecuteHistoricalAsync()
    {
        var hour = DateTime.UtcNow.Hour;
        var idx = Math.Min(hour % HistoricalProfile.Length, HistoricalProfile.Length - 1);
        var weightedSize = RoundToLot(_sliceSize * HistoricalProfile[idx]);
        await ExecuteSliceAsync("balanced", Math.Min(weightedSize, RemainingSize));
    }

    private async Task ExecuteSliceAsync(string urgency, decimal? overrideSize = null)
    {
        var size = overrideSize ?? Math.Min(_sliceSize, RemainingSize);
        if (size <= 0) return;
        _currentSlice++;

        var tick = Params.TickSize;
        decimal limitPrice = urgency switch
        {
            "aggressive" => Params.Side.ToUpper() == "BUY" ? RoundToTick(CurrentAsk + tick) : RoundToTick(CurrentBid - tick),
            "passive" => Params.Side.ToUpper() == "BUY" ? RoundToTick(CurrentBid) : RoundToTick(CurrentAsk),
            _ => RoundToTick(CurrentMid)
        };
        if (limitPrice <= 0) { ScheduleNextSlice(); return; }

        var tif = urgency == "aggressive" ? "IOC" : "GTC";
        await SubmitOrderAsync(new OrderIntent(
            StrategyId, NewClientOrderId(), Params.Exchange, Params.Symbol,
            Params.Side.ToUpper(), "LIMIT", size, limitPrice, null, tif,
            PostOnly: urgency == "passive", Tag: $"vwap_{_currentSlice}"));
        ScheduleNextSlice();
    }

    private async Task FinalSweepAsync()
    {
        if (RemainingSize <= Params.LotSize / 2) { Status = AlgoStatus.Completed; return; }
        Status = AlgoStatus.Completing;
        await CancelAllPendingAsync();
        var tick = Params.TickSize;
        var limitPrice = Params.Side.ToUpper() == "BUY" ? RoundToTick(CurrentAsk + tick * 5) : RoundToTick(CurrentBid - tick * 5);
        await SubmitOrderAsync(new OrderIntent(StrategyId, NewClientOrderId(), Params.Exchange, Params.Symbol,
            Params.Side.ToUpper(), "LIMIT", RemainingSize, limitPrice, null, "IOC", Tag: "sweep"));
        _ = Task.Delay(10_000).ContinueWith(_ => { if (Status == AlgoStatus.Completing) Status = AlgoStatus.Completed; });
    }

    private void ScheduleNextSlice()
    {
        var variance = (long)(_sliceIntervalMs * ((Params.ScheduleVariancePct ?? 10) / 100m));
        _nextSliceAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + _sliceIntervalMs + _rng.NextInt64(-variance, variance);
    }

    protected override void OnFillReceived(AlgoFill fill) => ScheduleNextSlice();
    protected override void OnRejectionReceived(string cid, string reason) => _retryAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 2000;
    protected override int GetCurrentSlice() => _currentSlice;
    protected override int GetTotalSlices() => _numSlices;
    protected override long? GetNextSliceAt() => _nextSliceAt;
    protected override string? GetSummaryLine() => $"{Params.Side} {Params.TotalSize} {Params.Symbol} via VWAP | {Params.VwapMode} | {Params.DurationMinutes}min";
}
