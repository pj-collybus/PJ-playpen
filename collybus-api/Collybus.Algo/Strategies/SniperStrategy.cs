using Collybus.Algo.Models;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

/// <summary>
/// Sniper — multi-level price ladder sniper and post+snipe execution.
/// Fixed: per-level IOC timeout guard, retrigger cooldown, post_snipe snipe guard.
/// </summary>
public class SniperStrategy : BaseStrategy
{
    public override string StrategyType => "SNIPER";

    private List<SniperLevelState> _levels = new();
    private readonly Random _rng = new();
    private long? _retryAt;
    private string? _postOrderClientId;
    private bool _postOrderActive;
    private string? _snipeChildId;     // active snipe IOC in post_snipe mode
    private int _round;
    private decimal _lastTradeSize;
    private decimal _priceAtMomentumStart;
    private long _momentumStart;
    private decimal _volumeAtLevel;
    private long _volumeWindowStart;
    private int _retriggerCooldownMs = 3000;
    private int _maxRetriggers = 5;

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
        _retriggerCooldownMs = 3000;
        _maxRetriggers = 5;

        if (p.Levels?.Any() == true)
        {
            var enabledLevels = p.Levels.Where(l => l.Enabled).ToList();
            var snipeTotal = p.SnipeCap.HasValue
                ? RoundToLot(p.TotalSize * p.SnipeCap.Value / 100m)
                : RoundToLot(p.TotalSize * enabledLevels.Sum(l => l.AllocationPct) / 100m);

            _levels = enabledLevels
                .OrderBy(l => p.Side.ToUpper() == "BUY" ? l.Price : -l.Price)
                .Select(l =>
                {
                    // Calculate size: try pct first, fallback to equal split of snipe total
                    var allocSize = l.AllocationPct > 0
                        ? RoundToLot(p.TotalSize * l.AllocationPct / 100m)
                        : 0m;
                    // If rounded to 0 (lot size > individual allocation), split snipe total equally
                    if (allocSize <= 0)
                        allocSize = RoundToLot(snipeTotal / enabledLevels.Count);
                    // Still 0? Use minimum 1 lot
                    if (allocSize <= 0)
                        allocSize = p.LotSize;
                    return new SniperLevelState(l.Index, l.Price, l.AllocationPct,
                        Math.Min(allocSize, snipeTotal));
                })
                .ToList();
        }
        else
        {
            _levels = [new SniperLevelState(0, p.TriggerPrice ?? CurrentAsk, 100m, RoundToLot(p.TotalSize))];
        }

        // Log level sizes to catch zero-allocation bugs
        foreach (var lv in _levels)
            Logger.LogInformation("[Sniper] {Sid} L{Idx}: price={Price} alloc={Pct}% target={Size}",
                StrategyId, lv.Index, lv.Price, lv.AllocationPct, lv.TargetSize);

        Logger.LogInformation("[Sniper] {Sid} started: mode={Mode} levelMode={LM} levels={N} totalSize={Size}",
            StrategyId, p.SniperMode, p.LevelMode, _levels.Count, p.TotalSize);
        return Task.CompletedTask;
    }

    public override async Task OnTickAsync()
    {
        if (Status != AlgoStatus.Running) return;
        // Guard: don't fire anything without live market data
        if (CurrentBid <= 0 || CurrentAsk <= 0) return;

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (_retryAt.HasValue && now >= _retryAt.Value) _retryAt = null;

        if (Params.SniperMode == "post_snipe")
            await TickPostSnipeAsync(now);
        else
            await TickSnipeAsync(now);
    }

    // ── Snipe mode (sequential / simultaneous) ────────────────────────────────

    private async Task TickSnipeAsync(long now)
    {
        if (Params.LevelMode == "simultaneous")
        {
            foreach (var level in _levels)
            {
                if (level.Status == LevelStatus.Completed) continue;
                if (level.RetriggerCount >= _maxRetriggers) { level.Status = LevelStatus.Completed; continue; }

                // IOC timeout guard: if child was submitted >5s ago and no fill, clear it
                if (level.ActiveClientId != null)
                {
                    if (now - level.IntentSubmittedAt < 5000) continue; // still in flight
                    Logger.LogDebug("[Sniper] {Sid} L{Idx} IOC timeout — clearing", StrategyId, level.Index);
                    level.ActiveClientId = null;
                    level.IntentSubmittedAt = 0;
                }

                // Per-level retrigger cooldown
                if (level.RetriggerAt > 0 && now < level.RetriggerAt) continue;

                await CheckAndFireLevelAsync(level, now);
            }
        }
        else
        {
            // Sequential: only first non-completed level
            var level = _levels.FirstOrDefault(l => l.Status != LevelStatus.Completed);
            if (level == null) { Status = AlgoStatus.Completed; OnCompleted(); return; }

            if (level.ActiveClientId != null)
            {
                if (now - level.IntentSubmittedAt < 5000) return;
                level.ActiveClientId = null;
                level.IntentSubmittedAt = 0;
            }
            if (level.RetriggerAt > 0 && now < level.RetriggerAt) return;

            await CheckAndFireLevelAsync(level, now);
        }

        if (_levels.All(l => l.Status == LevelStatus.Completed))
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
        }
    }

    private async Task CheckAndFireLevelAsync(SniperLevelState level, long now)
    {
        if (level.ActiveClientId != null) return; // guard: already in flight
        if (!IsPriceTriggered(level.Price)) { level.Status = LevelStatus.Waiting; return; }
        if (Params.MinVolume.HasValue && !VolumeConfirmed()) { level.Status = LevelStatus.Confirming; return; }
        if (Params.MomentumBps.HasValue && !MomentumConfirmed()) return;
        if (CurrentSpreadBps > (Params.MaxSpreadBps ?? 50)) return;

        await FireLevelAsync(level, now);
    }

    private async Task FireLevelAsync(SniperLevelState level, long now)
    {
        level.Status = LevelStatus.Firing;
        var qty = Math.Min(level.TargetSize - level.Filled, RemainingSize);
        qty = RoundToLot(qty);
        if (qty <= 0) { level.Status = LevelStatus.Completed; return; }

        var clientId = NewClientOrderId();
        level.ActiveClientId = clientId;
        level.IntentSubmittedAt = now;

        var tick = Params.TickSize;
        var price = Params.Side.ToUpper() == "BUY" ? CurrentAsk + tick : CurrentBid - tick;
        await SubmitOrderAsync(new OrderIntent(StrategyId, clientId, Params.Exchange, Params.Symbol,
            Params.Side.ToUpper(), "LIMIT", qty, RoundToTick(price), null, "IOC",
            Tag: $"snipe_L{level.Index}"));

        Logger.LogInformation("[Sniper] {Sid} L{Idx} fire: {Qty} @ {Price}",
            StrategyId, level.Index, qty, price);
    }

    // ── Post+Snipe mode ────────────────────────────────────────────────────────

    private async Task TickPostSnipeAsync(long now)
    {
        if (RemainingSize <= Params.LotSize / 2)
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
            return;
        }

        var postPrice = Params.PostPrice ?? (Params.Side.ToUpper() == "BUY" ? CurrentBid : CurrentAsk);
        var snipeCeiling = Params.SnipeCeiling ?? (Params.Side.ToUpper() == "BUY" ? CurrentAsk : CurrentBid);
        var snipeCap = Params.SnipeCap ?? 50m;

        // Place passive resting order (once)
        if (!_postOrderActive && RemainingSize > 0)
        {
            var snipeAlloc = RoundToLot(RemainingSize * snipeCap / 100m);
            var postAlloc = RemainingSize - snipeAlloc;
            if (postAlloc > 0)
            {
                _round++;
                _postOrderClientId = NewClientOrderId();
                _postOrderActive = true;
                await SubmitOrderAsync(new OrderIntent(StrategyId, _postOrderClientId, Params.Exchange, Params.Symbol,
                    Params.Side.ToUpper(), "LIMIT", postAlloc, RoundToTick(postPrice), null, "GTC",
                    PostOnly: true, Tag: $"post_r{_round}"));
            }
        }

        // Simultaneous level snipes (each level fires independently with guards)
        if (Params.LevelMode == "simultaneous" && _levels.Count > 0)
        {
            foreach (var lvl in _levels)
            {
                if (lvl.Status == LevelStatus.Completed) continue;
                if (lvl.RetriggerCount >= _maxRetriggers) { lvl.Status = LevelStatus.Completed; continue; }

                // IOC timeout guard
                if (lvl.ActiveClientId != null)
                {
                    if (now - lvl.IntentSubmittedAt < 5000) continue;
                    lvl.ActiveClientId = null;
                    lvl.IntentSubmittedAt = 0;
                }

                // Retrigger cooldown
                if (lvl.RetriggerAt > 0 && now < lvl.RetriggerAt) continue;

                // Trigger check
                if (!IsPriceTriggered(lvl.Price)) { lvl.Status = LevelStatus.Waiting; continue; }
                if (CurrentSpreadBps > (Params.MaxSpreadBps ?? 50)) continue;

                // Fire
                lvl.Status = LevelStatus.Firing;
                var lvlRemaining = Math.Max(0, lvl.TargetSize - lvl.Filled);
                var qty = RoundToLot(Math.Min(lvlRemaining, RemainingSize));
                if (qty <= 0) { lvl.Status = LevelStatus.Completed; continue; }

                var clientId = NewClientOrderId();
                lvl.ActiveClientId = clientId;
                lvl.IntentSubmittedAt = now;
                var tick = Params.TickSize;
                var price = Params.Side.ToUpper() == "BUY" ? CurrentAsk + tick : CurrentBid - tick;
                await SubmitOrderAsync(new OrderIntent(StrategyId, clientId, Params.Exchange, Params.Symbol,
                    Params.Side.ToUpper(), "LIMIT", qty, RoundToTick(price), null, "IOC",
                    Tag: $"snipe_L{lvl.Index}"));

                Logger.LogInformation("[Sniper] {Sid} post+snipe L{Idx} fire: {Qty} @ {Price}",
                    StrategyId, lvl.Index, qty, price);
            }
            return;
        }

        // Sequential snipe (single IOC at a time)
        if (_snipeChildId != null) return; // guard: snipe already in flight

        var snipeAllocSeq = RoundToLot(RemainingSize * snipeCap / 100m);
        if (snipeAllocSeq > 0 && IsPriceTriggered(snipeCeiling))
        {
            var tick = Params.TickSize;
            var price = Params.Side.ToUpper() == "BUY" ? CurrentAsk + tick : CurrentBid - tick;
            _snipeChildId = NewClientOrderId();
            await SubmitOrderAsync(new OrderIntent(StrategyId, _snipeChildId, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", snipeAllocSeq, RoundToTick(price), null, "IOC",
                Tag: $"postsnipe_r{_round}"));
        }
    }

    // ── Fill handling ────────────────────────────────────────────────────────────

    protected override void OnFillReceived(AlgoFill fill)
    {
        if (fill.ClientOrderId == _postOrderClientId) _postOrderActive = false;
        if (fill.ClientOrderId == _snipeChildId) _snipeChildId = null;

        var level = _levels.FirstOrDefault(l => l.ActiveClientId == fill.ClientOrderId);
        if (level != null)
        {
            var cappedFill = Math.Min(fill.FillSize, Math.Max(0, level.TargetSize - level.Filled));
            level.Filled += cappedFill;
            level.ActiveClientId = null;
            level.IntentSubmittedAt = 0;

            var tolerance = Math.Max(Params.LotSize * 0.01m, 0.001m);
            if (level.Filled >= level.TargetSize - tolerance)
            {
                level.Status = LevelStatus.Completed;
                ApplyRetrigger(level);
            }
            else
            {
                // Partial fill — set retrigger cooldown before re-firing
                level.RetriggerCount++;
                level.RetriggerAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + _retriggerCooldownMs;
                level.Status = LevelStatus.Waiting;
                Logger.LogInformation("[Sniper] {Sid} L{Idx} partial: filled={F}/{T} retrigger in {Ms}ms (#{N})",
                    StrategyId, level.Index, level.Filled, level.TargetSize, _retriggerCooldownMs, level.RetriggerCount);
            }
        }
    }

    private void ApplyRetrigger(SniperLevelState level)
    {
        if (RemainingSize <= Params.LotSize / 2) return;
        if (level.RetriggerCount >= _maxRetriggers) return;

        switch (Params.RetriggerMode)
        {
            case "better":
                var ticks = Params.RetriggerTicks ?? 2;
                level.Price = Params.Side.ToUpper() == "BUY"
                    ? level.Price - ticks * Params.TickSize
                    : level.Price + ticks * Params.TickSize;
                level.Filled = 0;
                level.RetriggerCount++;
                level.RetriggerAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + _retriggerCooldownMs;
                level.Status = LevelStatus.Waiting;
                break;
            case "same":
                level.Filled = 0;
                level.RetriggerCount++;
                level.RetriggerAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + _retriggerCooldownMs;
                level.Status = LevelStatus.Waiting;
                break;
            case "vwap" when MarketVwap > 0:
                level.Price = RoundToTick(MarketVwap);
                level.Filled = 0;
                level.RetriggerCount++;
                level.RetriggerAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + _retriggerCooldownMs;
                level.Status = LevelStatus.Waiting;
                break;
        }
    }

    protected override void OnRejectionReceived(string clientOrderId, string reason)
    {
        if (clientOrderId == _postOrderClientId) _postOrderActive = false;
        if (clientOrderId == _snipeChildId) _snipeChildId = null;

        var level = _levels.FirstOrDefault(l => l.ActiveClientId == clientOrderId);
        if (level != null)
        {
            level.ActiveClientId = null;
            level.IntentSubmittedAt = 0;
            level.RetriggerAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 2000;
            level.Status = LevelStatus.Waiting;
        }
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
        _snipeChildId = null;
        var tick = Params.TickSize;
        var price = Params.Side.ToUpper() == "BUY" ? RoundToTick(CurrentAsk + tick * 3) : RoundToTick(CurrentBid - tick * 3);
        await SubmitOrderAsync(new OrderIntent(StrategyId, NewClientOrderId(), Params.Exchange, Params.Symbol,
            Params.Side.ToUpper(), "LIMIT", Math.Min(qty, RemainingSize), price, null, "IOC", Tag: "accelerate"));
    }

    protected override string? GetSummaryLine()
        => $"{Params.Side} {Params.TotalSize} {Params.Symbol} via SNIPER | {Params.SniperMode} | {_levels.Count} levels";
}

public class SniperLevelState
{
    public int Index { get; }
    public decimal Price { get; set; }
    public decimal AllocationPct { get; }
    public decimal TargetSize { get; }
    public decimal Filled { get; set; }
    public LevelStatus Status { get; set; } = LevelStatus.Waiting;
    public string? ActiveClientId { get; set; }
    public long IntentSubmittedAt { get; set; }
    public long RetriggerAt { get; set; }
    public int RetriggerCount { get; set; }

    public SniperLevelState(int index, decimal price, decimal allocationPct, decimal targetSize)
    {
        Index = index; Price = price; AllocationPct = allocationPct; TargetSize = targetSize;
    }
}

public enum LevelStatus { Waiting, Confirming, Firing, Completed }
