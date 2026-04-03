using Collybus.Algo.Models;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

public class PovStrategy : BaseStrategy
{
    public override string StrategyType => "POV";

    private readonly Queue<(decimal size, long ts)> _volumeWindow = new();
    private decimal _targetParticipation;
    private decimal _volumeInWindow;
    private decimal _ourVolumeInWindow;
    private long? _endAt;
    private long _lastCatchUpAt;
    private long? _retryAt;

    public PovStrategy(string strategyId, ILogger<PovStrategy> logger)
        : base(strategyId, logger) { }

    protected override Task OnActivateAsync()
    {
        _targetParticipation = (Params.ParticipationPct ?? 10m) / 100m;
        if (Params.DurationMinutes.HasValue)
            _endAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + Params.DurationMinutes.Value * 60_000L;
        Logger.LogInformation("[POV] {Sid} started: participation={Pct}%", StrategyId, Params.ParticipationPct);
        return Task.CompletedTask;
    }

    public override void OnMarketData(MarketDataPoint data)
    {
        base.OnMarketData(data);
        if (Status != AlgoStatus.Running || data.LastTradeSize <= 0) return;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _volumeWindow.Enqueue((data.LastTradeSize, now));
        _volumeInWindow += data.LastTradeSize;

        var targetQty = RoundToLot(data.LastTradeSize * _targetParticipation);
        if (Params.MinChildSize.HasValue) targetQty = Math.Max(targetQty, Params.MinChildSize.Value);
        if (Params.MaxChildSize.HasValue) targetQty = Math.Min(targetQty, Params.MaxChildSize.Value);
        targetQty = Math.Min(targetQty, RemainingSize);
        if (targetQty < Params.LotSize) return;

        if (Params.LimitPrice.HasValue && Params.LimitMode == "market_limit")
        {
            if (Params.Side.ToUpper() == "BUY" ? CurrentMid > Params.LimitPrice.Value : CurrentMid < Params.LimitPrice.Value)
                return;
        }

        _ = FireChildAsync(targetQty);
    }

    public override async Task OnTickAsync()
    {
        if (Status != AlgoStatus.Running) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        if (_endAt.HasValue && now >= _endAt.Value) { Status = AlgoStatus.Completed; return; }
        if (_retryAt.HasValue && now >= _retryAt.Value) _retryAt = null;

        var windowMs = (Params.VolumeWindowSeconds ?? 60) * 1000L;
        var cutoff = now - windowMs;
        while (_volumeWindow.Count > 0 && _volumeWindow.Peek().ts < cutoff)
        {
            var item = _volumeWindow.Dequeue();
            _volumeInWindow = Math.Max(0, _volumeInWindow - item.size);
        }

        if (now - _lastCatchUpAt > 10_000)
        {
            await CheckCatchUpAsync();
            _lastCatchUpAt = now;
        }
    }

    private async Task FireChildAsync(decimal qty)
    {
        if (qty <= 0 || RemainingSize <= 0 || CurrentAsk <= 0) return;
        var limitPrice = Params.Side.ToUpper() == "BUY" ? RoundToTick(CurrentAsk) : RoundToTick(CurrentBid);
        if (limitPrice <= 0) return;
        await SubmitOrderAsync(new OrderIntent(StrategyId, NewClientOrderId(), Params.Exchange, Params.Symbol,
            Params.Side.ToUpper(), "LIMIT", qty, limitPrice, null, "IOC", Tag: "pov_child"));
    }

    private async Task CheckCatchUpAsync()
    {
        if (_volumeInWindow <= 0 || RemainingSize <= 0) return;
        var actual = _ourVolumeInWindow / _volumeInWindow;
        var deficit = (_targetParticipation - actual) * _volumeInWindow;
        if (deficit < Params.LotSize) return;
        var qty = RoundToLot(Math.Min(deficit, RemainingSize));
        if (qty < Params.LotSize) return;
        Logger.LogInformation("[POV] {Sid} catch-up: actual={A:P1} target={T:P1} qty={Q}",
            StrategyId, actual, _targetParticipation, qty);
        await FireChildAsync(qty);
    }

    protected override void OnFillReceived(AlgoFill fill)
    {
        _ourVolumeInWindow += fill.FillSize;
    }

    protected override void OnRejectionReceived(string cid, string reason)
        => _retryAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 2000;

    public override async Task AccelerateAsync(decimal qty)
    {
        var price = Params.Side.ToUpper() == "BUY" ? RoundToTick(CurrentAsk * 1.002m) : RoundToTick(CurrentBid * 0.998m);
        await SubmitOrderAsync(new OrderIntent(StrategyId, NewClientOrderId(), Params.Exchange, Params.Symbol,
            Params.Side.ToUpper(), "LIMIT", Math.Min(qty, RemainingSize), price, null, "IOC", Tag: "accelerate"));
    }

    protected override string? GetSummaryLine()
        => $"{Params.Side} {Params.TotalSize} {Params.Symbol} via POV | {Params.ParticipationPct}% participation";
}
