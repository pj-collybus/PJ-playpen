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
    private bool _placing;
    private int _round;
    private decimal _lastTradeSize;
    private decimal _priceAtMomentumStart;
    private long _momentumStart;
    private decimal _volumeAtLevel;
    private long _volumeWindowStart;
    private int _retriggerCooldownMs = 3000;
    private int _maxRetriggers = 0; // default: no retrigger — each level fires once

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
        _maxRetriggers = 0; // each level fires once unless retrigger is explicitly enabled

        if (p.Levels?.Any() == true)
        {
            var enabledLevels = p.Levels.Where(l => l.Enabled)
                .OrderBy(l => p.Side.ToUpper() == "BUY" ? l.Price : -l.Price)
                .ToList();

            // Check if levels have explicit sizes (from discretionService)
            var hasExplicitSizes = enabledLevels.Any(l => l.Size > 0);

            if (hasExplicitSizes)
            {
                // Use sizes directly — they are already lot-aware from discretionService
                _levels = enabledLevels.Select(l =>
                    new SniperLevelState(l.Index, l.Price, l.AllocationPct, l.Size))
                    .ToList();
            }
            else
            {
                // Calculate from allocationPct — snipeTotal is the total for snipe levels
                var snipeTotal = p.SniperMode == "post_snipe" && p.SnipeCap.HasValue
                    ? RoundToLot(p.TotalSize * p.SnipeCap.Value / 100m)
                    : p.TotalSize;

                // Allocate floored to lot, distribute remainder evenly
                decimal totalAllocated = 0;
                var levelStates = enabledLevels.Select(l =>
                {
                    var floored = RoundToLot(snipeTotal * l.AllocationPct / 100m);
                    if (floored <= 0) floored = p.LotSize;
                    totalAllocated += floored;
                    return new SniperLevelState(l.Index, l.Price, l.AllocationPct, floored);
                }).ToList();

                // Distribute remainder as whole lots from the end
                var remainder = snipeTotal - totalAllocated;
                if (remainder > 0 && levelStates.Count > 0)
                {
                    var remainderLots = (int)Math.Floor(remainder / p.LotSize);
                    for (int i = levelStates.Count - 1; i >= 0 && remainderLots > 0; i--)
                    {
                        levelStates[i] = new SniperLevelState(
                            levelStates[i].Index, levelStates[i].Price, levelStates[i].AllocationPct,
                            levelStates[i].TargetSize + p.LotSize);
                        remainderLots--;
                    }
                    var dust = snipeTotal - levelStates.Sum(l => l.TargetSize);
                    if (dust > 0)
                        levelStates[^1] = new SniperLevelState(
                            levelStates[^1].Index, levelStates[^1].Price, levelStates[^1].AllocationPct,
                            levelStates[^1].TargetSize + dust);
                }
                _levels = levelStates;
            }
        }
        else
        {
            _levels = [new SniperLevelState(0, p.TriggerPrice ?? CurrentAsk, 100m, p.TotalSize)];
        }

        // Log final allocation
        var levelSum = _levels.Sum(l => l.TargetSize);
        foreach (var lv in _levels)
            Logger.LogInformation("[Sniper] {Sid} L{Idx}: price={Price} target={Size}",
                StrategyId, lv.Index, lv.Price, lv.TargetSize);
        if (p.SniperMode == "post_snipe")
        {
            var postSz = p.PostSize > 0 ? p.PostSize.Value : RoundToLot(p.TotalSize * (100m - (p.SnipeCap ?? 50m)) / 100m);
            Logger.LogInformation("[Sniper] {Sid} discretion: post={Post} + snipe={Snipe} = {Total} (expected {Expected})",
                StrategyId, postSz, levelSum, postSz + levelSum, p.TotalSize);
        }
        else
        {
            Logger.LogInformation("[Sniper] {Sid} snipe total={Sum} expected={Expected}",
                StrategyId, levelSum, p.TotalSize);
        }

        Logger.LogInformation("[Sniper] {Sid} started: mode={Mode} levelMode={LM} levels={N} totalSize={Size} " +
            "postPrice={Post} snipeCeiling={Ceil} snipeCap={Cap} bid={Bid} ask={Ask}",
            StrategyId, p.SniperMode, p.LevelMode, _levels.Count, p.TotalSize,
            p.PostPrice, p.SnipeCeiling, p.SnipeCap, CurrentBid, CurrentAsk);
        return Task.CompletedTask;
    }

    public override async Task OnTickAsync()
    {
        if (Status != AlgoStatus.Running) return;
        if (CurrentBid <= 0 || CurrentAsk <= 0) return;

        Logger.LogDebug("[Sniper] {Sid} tick: bid={Bid} ask={Ask} levels={Levels}",
            StrategyId, CurrentBid, CurrentAsk,
            string.Join(" ", _levels.Select(l => $"L{l.Index}={l.Status}")));

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
                if (level.RetriggerCount >= _maxRetriggers && _maxRetriggers > 0) { level.Status = LevelStatus.Completed; continue; }

                // IOC timeout guard: if child was submitted >5s ago and no fill, clear it
                if (level.ActiveClientId != null)
                {
                    if (now - level.IntentSubmittedAt < 5000) continue; // still in flight
                    Logger.LogDebug("[Sniper] {Sid} L{Idx} IOC timeout — clearing", StrategyId, level.Index);
                    level.ActiveClientId = null;
                    level.IntentSubmittedAt = 0;
                    // Set cooldown so we don't immediately re-fire
                    level.RetriggerAt = now + _retriggerCooldownMs;
                }

                // Per-level retrigger cooldown
                if (level.RetriggerAt > 0 && now < level.RetriggerAt) continue;

                // Placing guard
                if (level.Placing) continue;

                await CheckAndFireLevelAsync(level, now);
            }
        }
        else
        {
            // Sequential: only first non-completed level
            var level = _levels.FirstOrDefault(l => l.Status != LevelStatus.Completed);
            if (level == null)
            {
                if (FilledSize >= Params.TotalSize - Params.LotSize / 2)
                    { Status = AlgoStatus.Completed; OnCompleted(); }
                return;
            }

            if (level.ActiveClientId != null)
            {
                if (now - level.IntentSubmittedAt < 5000) return;
                level.ActiveClientId = null;
                level.IntentSubmittedAt = 0;
                level.RetriggerAt = now + _retriggerCooldownMs;
            }
            if (level.Placing) return;
            if (level.RetriggerAt > 0 && now < level.RetriggerAt) return;

            await CheckAndFireLevelAsync(level, now);
        }

        // Only complete from snipe tick if overall strategy is fully filled
        // (post_snipe has a resting order that may still be pending)
        if (_levels.All(l => l.Status == LevelStatus.Completed)
            && FilledSize >= Params.TotalSize - Params.LotSize / 2)
        {
            Status = AlgoStatus.Completed;
            OnCompleted();
        }
    }

    private async Task CheckAndFireLevelAsync(SniperLevelState level, long now)
    {
        if (level.ActiveClientId != null) return; // guard: already in flight
        var triggered = IsPriceTriggered(level.Price);
        Logger.LogDebug("[Sniper] {Sid} L{Idx} trigger: side={Side} ask={Ask} bid={Bid} lvlPrice={Lvl} triggered={T}",
            StrategyId, level.Index, Params.Side, CurrentAsk, CurrentBid, level.Price, triggered);
        if (!triggered) { level.Status = LevelStatus.Waiting; return; }
        if (Params.MinVolume.HasValue && !VolumeConfirmed()) { level.Status = LevelStatus.Confirming; return; }
        if (Params.MomentumBps.HasValue && !MomentumConfirmed()) return;
        if (CurrentSpreadBps > (Params.MaxSpreadBps ?? 50)) return;

        await FireLevelAsync(level, now);
    }

    private async Task FireLevelAsync(SniperLevelState level, long now)
    {
        if (level.Placing) return;
        level.Status = LevelStatus.Firing;
        var qty = Math.Min(level.TargetSize - level.Filled, RemainingSize);
        qty = RoundToLot(qty);
        if (qty <= 0) { level.Status = LevelStatus.Completed; return; }

        var clientId = NewClientOrderId();
        level.ActiveClientId = clientId;
        level.IntentSubmittedAt = now;

        var tick = Params.TickSize;
        var price = Params.Side.ToUpper() == "BUY" ? CurrentAsk + tick : CurrentBid - tick;
        level.Placing = true;
        try
        {
            await SubmitOrderAsync(new OrderIntent(StrategyId, clientId, Params.Exchange, Params.Symbol,
                Params.Side.ToUpper(), "LIMIT", qty, RoundToTick(price), null, "IOC",
                Tag: $"snipe_L{level.Index}"));
        }
        finally { level.Placing = false; }

        Logger.LogInformation("[Sniper] {Sid} L{Idx} fire: {Qty} @ {Price}",
            StrategyId, level.Index, qty, price);
    }

    // ── Post+Snipe mode ────────────────────────────────────────────────────────
    // Post+Snipe = one resting GTC limit + standard snipe levels (reuses TickSnipeAsync)

    private async Task TickPostSnipeAsync(long now)
    {
        // Place passive resting order ONCE at startup
        if (!_postOrderActive && !_placing && _postOrderClientId == null)
        {
            var postPrice = Params.PostPrice ?? (Params.Side.ToUpper() == "BUY" ? CurrentBid : CurrentAsk);
            var snipeCap = Params.SnipeCap ?? 50m;
            var postSize = Params.PostSize > 0
                ? Params.PostSize.Value
                : RoundToLot(Params.TotalSize * (100m - snipeCap) / 100m);
            if (postSize > 0)
            {
                _postOrderClientId = NewClientOrderId();
                _postOrderActive = true;
                _placing = true;
                try
                {
                    await SubmitOrderAsync(new OrderIntent(StrategyId, _postOrderClientId, Params.Exchange, Params.Symbol,
                        Params.Side.ToUpper(), "LIMIT", postSize, RoundToTick(postPrice), null, "GTC",
                        Tag: "post"));
                    Logger.LogInformation("[Sniper] {Sid} post order: {Size} @ {Price} GTC",
                        StrategyId, postSize, postPrice);
                }
                finally { _placing = false; }
            }
        }

        // Snipe levels — reuse exact same simultaneous logic as pure snipe mode
        await TickSnipeAsync(now);
    }

    // ── Fill handling ────────────────────────────────────────────────────────────

    protected override void OnFillReceived(AlgoFill fill)
    {
        // Post order fill
        if (fill.ClientOrderId == _postOrderClientId)
        {
            _postOrderActive = false;
            Logger.LogInformation("[Sniper] {Sid} post fill: {Size}@{Price}",
                StrategyId, fill.FillSize, fill.FillPrice);
            return; // base class already tracked filledSize
        }

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

    protected override void OnPause()
    {
        // Clear active IDs (orders cancelled by base), preserve fill progress
        _postOrderActive = false;
        _postOrderClientId = null;
        _snipeChildId = null;
        foreach (var l in _levels) { l.ActiveClientId = null; l.Placing = false; l.IntentSubmittedAt = 0; }
        _placing = false;
    }

    protected override async Task OnResumeAsync()
    {
        // Re-place post order if post+snipe and post wasn't fully filled
        if (Params.SniperMode == "post_snipe")
        {
            var snipeCap = Params.SnipeCap ?? 50m;
            var postSize = Params.PostSize > 0
                ? Params.PostSize.Value
                : RoundToLot(Params.TotalSize * (100m - snipeCap) / 100m);
            var postFilled = FilledSize - _levels.Sum(l => l.Filled);
            var postRemaining = Math.Max(0, postSize - Math.Max(0, postFilled));
            if (postRemaining > 0)
            {
                var postPrice = Params.PostPrice ?? (Params.Side.ToUpper() == "BUY" ? CurrentBid : CurrentAsk);
                _postOrderClientId = NewClientOrderId();
                _postOrderActive = true;
                await SubmitOrderAsync(new OrderIntent(StrategyId, _postOrderClientId, Params.Exchange, Params.Symbol,
                    Params.Side.ToUpper(), "LIMIT", postRemaining, RoundToTick(postPrice), null, "GTC", Tag: "post_resume"));
                Logger.LogInformation("[Sniper] {Sid} resumed post: {Size} @ {Price}", StrategyId, postRemaining, postPrice);
            }
        }
        // Snipe levels reactivate naturally on next tick — no need to re-place IOCs
    }

    protected override string? GetSummaryLine()
    {
        var mode = Params.SniperMode == "post_snipe" ? "POST+SNIPE" : "SNIPE";
        return $"{Params.Side} {Params.TotalSize} {Params.Symbol} on {Params.Exchange} via SNIPER | {mode} | {_levels.Count} levels";
    }

    protected override void PopulateStrategyState(AlgoStatusReport report)
    {
        report.ExecutionMode = Params.SniperMode;
        report.LevelMode = Params.LevelMode;
        report.TargetPrice = Params.PostPrice;
        report.SnipeLevel = Params.SnipeCeiling;
        report.SnipePct = Params.SnipeCap;
        report.PostSnipePhase = _postOrderActive ? "ACTIVE" : "REST_ONLY";
        report.RoundNumber = _round;
        report.Urgency = "snipe";
        report.ChartTargetPrice = Params.SniperMode == "post_snipe" && Params.PostPrice > 0 ? Params.PostPrice : null;
        report.ChartSnipeLevel = Params.SniperMode == "post_snipe" && Params.LevelMode != "simultaneous"
            ? Params.SnipeCeiling : null;
        report.ChartLevelPrices = _levels.Select(l => new ChartLevelPrice
        {
            Price = l.Price, Status = l.Status.ToString()
        }).ToList();
        report.Levels = _levels.Select(l => new Models.LevelState
        {
            Price = l.Price, AllocatedSize = l.TargetSize, FilledSize = l.Filled,
            Status = l.Status.ToString(), RetriggerCount = l.RetriggerCount,
        }).ToList();
    }
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
    public bool Placing { get; set; }

    public SniperLevelState(int index, decimal price, decimal allocationPct, decimal targetSize)
    {
        Index = index; Price = price; AllocationPct = allocationPct; TargetSize = targetSize;
    }
}

public enum LevelStatus { Waiting, Confirming, Firing, Completed }
