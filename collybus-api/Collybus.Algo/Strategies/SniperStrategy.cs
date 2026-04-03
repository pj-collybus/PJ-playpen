using Collybus.Algo.Models;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

/// <summary>
/// Sniper — multi-level price ladder sniper and post+snipe execution.
/// Translated from sniper.js (1003 lines).
/// Modes: snipe (IOC at trigger levels), post_snipe (passive rest + active snipe).
/// Level modes: sequential (one at a time), simultaneous (all independent).
/// </summary>
public class SniperStrategy : BaseStrategy
{
    public override string StrategyType => "SNIPER";

    private List<SniperLevelState> _levels = new();
    private readonly Random _rng = new();
    private long? _retryAt;
    private string? _postOrderClientId;
    private bool _postOrderActive;
    private int _round;
    private decimal _volumeAtLevel;
    private long _volumeWindowStart;
    private decimal _lastTradeSize;
    private decimal _priceAtMomentumStart;
    private long _momentumStart;

    public SniperStrategy(string strategyId, ILogger<SniperStrategy> logger)
        : base(strategyId, logger) { }

    public override void OnMarketData(MarketDataPoint data)
    {
        base.OnMarketData(data);
        _lastTradeSize = data.LastTradeSize;
    }

    protected override Task OnActivateAsync()
    {
        var p = Params;
        if (p.Levels?.Any() == true)
        {
            _levels = p.Levels.Where(l => l.Enabled)
                .OrderBy(l => p.Side.ToUpper() == "BUY" ? l.Price : -l.Price)
                .Select(l => new SniperLevelState(l.Index, l.Price, l.AllocationPct,
                    RoundToLot(p.TotalSize * l.AllocationPct / 100m), LevelStatus.Waiting))
                .ToList();
        }
        else
        {
            _levels = [new SniperLevelState(0, p.TriggerPrice ?? CurrentAsk, 100m, RoundToLot(p.TotalSize), LevelStatus.Waiting)];
        }
        Logger.LogInformation("[Sniper] {Sid} started: mode={Mode} levels={N} totalSize={Size}",
            StrategyId, p.SniperMode, _levels.Count, p.TotalSize);
        return Task.CompletedTask;
    }

    public override async Task OnTickAsync()
    {
        if (Status != AlgoStatus.Running) return;
        if (_retryAt.HasValue && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= _retryAt.Value) _retryAt = null;

        if (Params.SniperMode == "post_snipe")
            await TickPostSnipeAsync();
        else
            await TickSnipeAsync();
    }

    private async Task TickSnipeAsync()
    {
        if (Params.LevelMode == "simultaneous")
        {
            foreach (var level in _levels.Where(l => l.Status == LevelStatus.Waiting && l.ActiveClientId == null))
                await CheckAndFireLevelAsync(level);
        }
        else
        {
            var level = _levels.FirstOrDefault(l => l.Status == LevelStatus.Waiting && l.ActiveClientId == null);
            if (level != null) await CheckAndFireLevelAsync(level);
        }

        // All levels done?
        if (_levels.All(l => l.Status == LevelStatus.Completed))
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
        }
    }

    private async Task CheckAndFireLevelAsync(SniperLevelState level)
    {
        if (!IsPriceTriggered(level.Price)) return;
        if (Params.MinVolume.HasValue && !VolumeConfirmed()) { level.Status = LevelStatus.Confirming; return; }
        if (Params.MomentumBps.HasValue && !MomentumConfirmed()) return;
        if (CurrentSpreadBps > (Params.MaxSpreadBps ?? 50)) return;
        await FireLevelAsync(level);
    }

    private async Task FireLevelAsync(SniperLevelState level)
    {
        level.Status = LevelStatus.Firing;
        var qty = Math.Min(level.TargetSize - level.Filled, RemainingSize);
        qty = RoundToLot(qty);
        if (qty <= 0) { level.Status = LevelStatus.Completed; return; }

        if (Params.IcebergSnipe && qty > Params.LotSize * 3)
        {
            await FireIcebergAsync(level, qty);
        }
        else
        {
            var clientId = NewClientOrderId();
            level.ActiveClientId = clientId;
            var tick = Params.TickSize;
            var price = Params.Side.ToUpper() == "BUY" ? CurrentAsk + tick : CurrentBid - tick;
            await SubmitOrderAsync(new OrderIntent(StrategyId, clientId, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", qty, RoundToTick(price), null, "IOC", Tag: $"snipe_L{level.Index}"));
        }
    }

    private async Task FireIcebergAsync(SniperLevelState level, decimal totalQty)
    {
        var pct = Params.SniperSlicePct ?? 25m;
        var sliceSize = RoundToLot(totalQty * pct / 100m);
        if (sliceSize <= 0) sliceSize = Params.LotSize;
        var remaining = totalQty;
        var tick = Params.TickSize;

        while (remaining > 0)
        {
            var qty = Math.Min(sliceSize, remaining);
            remaining -= qty;
            var clientId = NewClientOrderId();
            level.ActiveClientId = clientId;
            var price = Params.Side.ToUpper() == "BUY" ? CurrentAsk + tick : CurrentBid - tick;
            await SubmitOrderAsync(new OrderIntent(StrategyId, clientId, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", qty, RoundToTick(price), null, "IOC", Tag: $"snipe_ice_L{level.Index}"));
            if (remaining > 0) await Task.Delay(_rng.Next(200, 801));
        }
    }

    private async Task TickPostSnipeAsync()
    {
        var postPrice = Params.PostPrice ?? (Params.Side.ToUpper() == "BUY" ? CurrentBid : CurrentAsk);
        var snipeCeiling = Params.SnipeCeiling ?? (Params.Side.ToUpper() == "BUY" ? CurrentAsk : CurrentBid);
        var snipeCap = Params.SnipeCap ?? 50m;
        _round++;

        var snipeAlloc = RoundToLot(RemainingSize * snipeCap / 100m);
        var postAlloc = RemainingSize - snipeAlloc;

        if (!_postOrderActive && postAlloc > 0)
        {
            _postOrderClientId = NewClientOrderId();
            _postOrderActive = true;
            await SubmitOrderAsync(new OrderIntent(StrategyId, _postOrderClientId, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", postAlloc, RoundToTick(postPrice), null, "GTC",
                PostOnly: true, Tag: $"post_r{_round}"));
        }

        if (snipeAlloc > 0 && IsPriceTriggered(snipeCeiling))
        {
            var tick = Params.TickSize;
            var price = Params.Side.ToUpper() == "BUY" ? CurrentAsk + tick : CurrentBid - tick;
            await SubmitOrderAsync(new OrderIntent(StrategyId, NewClientOrderId(), Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", snipeAlloc, RoundToTick(price), null, "IOC",
                Tag: $"postsnipe_r{_round}"));
        }
    }

    protected override void OnFillReceived(AlgoFill fill)
    {
        if (fill.ClientOrderId == _postOrderClientId) _postOrderActive = false;

        var level = _levels.FirstOrDefault(l => l.ActiveClientId == fill.ClientOrderId);
        if (level != null)
        {
            level.Filled += fill.FillSize;
            level.ActiveClientId = null;
            if (level.Filled >= level.TargetSize - Params.LotSize / 2)
            {
                level.Status = LevelStatus.Completed;
                ApplyRetrigger(level);
            }
            else
            {
                level.Status = LevelStatus.Waiting;
            }
        }
    }

    private void ApplyRetrigger(SniperLevelState level)
    {
        if (RemainingSize <= Params.LotSize / 2) return;
        switch (Params.RetriggerMode)
        {
            case "better":
                var ticks = Params.RetriggerTicks ?? 2;
                level.Price = Params.Side.ToUpper() == "BUY"
                    ? level.Price - ticks * Params.TickSize
                    : level.Price + ticks * Params.TickSize;
                level.Filled = 0;
                level.Status = LevelStatus.Waiting;
                break;
            case "same":
                level.Filled = 0;
                level.Status = LevelStatus.Waiting;
                break;
            case "vwap" when MarketVwap > 0:
                level.Price = RoundToTick(MarketVwap);
                level.Filled = 0;
                level.Status = LevelStatus.Waiting;
                break;
        }
    }

    protected override void OnRejectionReceived(string clientOrderId, string reason)
    {
        _postOrderActive = false;
        _retryAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 2000;
        var level = _levels.FirstOrDefault(l => l.ActiveClientId == clientOrderId);
        if (level != null) { level.ActiveClientId = null; level.Status = LevelStatus.Waiting; }
    }

    private bool IsPriceTriggered(decimal levelPrice)
        => Params.Side.ToUpper() == "BUY" ? CurrentAsk <= levelPrice : CurrentBid >= levelPrice;

    private bool VolumeConfirmed()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now - _volumeWindowStart > 5000) { _volumeAtLevel = 0; _volumeWindowStart = now; }
        _volumeAtLevel += _lastTradeSize;
        return _volumeAtLevel >= (Params.MinVolume ?? 0);
    }

    private bool MomentumConfirmed()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (_priceAtMomentumStart == 0) { _priceAtMomentumStart = CurrentMid; _momentumStart = now; return false; }
        var elapsedSec = (now - _momentumStart) / 1000m;
        if (elapsedSec < 0.5m) return false;
        var bpsPerSec = (CurrentMid - _priceAtMomentumStart) / _priceAtMomentumStart * 10000m / elapsedSec;
        var required = Params.MomentumBps ?? 0m;
        return Params.Side.ToUpper() == "BUY" ? bpsPerSec >= required : bpsPerSec <= -required;
    }

    public override async Task AccelerateAsync(decimal qty)
    {
        await CancelAllPendingAsync();
        _postOrderActive = false;
        var tick = Params.TickSize;
        var price = Params.Side.ToUpper() == "BUY" ? RoundToTick(CurrentAsk + tick * 3) : RoundToTick(CurrentBid - tick * 3);
        await SubmitOrderAsync(new OrderIntent(StrategyId, NewClientOrderId(), Params.Exchange, Params.Symbol,
            Params.Side.ToUpper(), "LIMIT", Math.Min(qty, RemainingSize), price, null, "IOC", Tag: "accelerate"));
    }

    protected override string? GetSummaryLine()
        => $"{Params.Side} {Params.TotalSize} {Params.Symbol} via SNIPER | {Params.SniperMode} | {_levels.Count} levels";
}

public class SniperLevelState(int Index, decimal Price, decimal AllocationPct, decimal TargetSize, LevelStatus Status)
{
    public int Index { get; } = Index;
    public decimal Price { get; set; } = Price;
    public decimal AllocationPct { get; } = AllocationPct;
    public decimal TargetSize { get; } = TargetSize;
    public decimal Filled { get; set; }
    public LevelStatus Status { get; set; } = Status;
    public string? ActiveClientId { get; set; }
}

public enum LevelStatus { Waiting, Confirming, Firing, Completed }
