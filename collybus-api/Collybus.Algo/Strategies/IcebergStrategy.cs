using Collybus.Algo.Models;
using Microsoft.Extensions.Logging;

namespace Collybus.Algo.Strategies;

public class IcebergStrategy : BaseStrategy
{
    public override string StrategyType => "ICEBERG";

    private readonly Random _rng = new();
    private bool _orderActive;
    private string? _activeClientId;
    private decimal _visibleSize;
    private long? _nextRefreshAt;
    private int _detectionRiskScore;
    private decimal _lastVisibleSize;
    private long? _retryAt;

    public IcebergStrategy(string strategyId, ILogger<IcebergStrategy> logger)
        : base(strategyId, logger) { }

    protected override async Task OnActivateAsync()
    {
        Logger.LogInformation("[Iceberg] {Sid} started: total={Total} visible={Vis}",
            StrategyId, Params.TotalSize, Params.VisibleSize);
        await PlaceVisibleOrderAsync();
    }

    public override async Task OnTickAsync()
    {
        if (Status != AlgoStatus.Running) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        if (_retryAt.HasValue && now >= _retryAt.Value) { _retryAt = null; await PlaceVisibleOrderAsync(); return; }

        if (!_orderActive && (!_nextRefreshAt.HasValue || now >= _nextRefreshAt.Value))
            await PlaceVisibleOrderAsync();
    }

    private async Task PlaceVisibleOrderAsync()
    {
        if (RemainingSize <= 0) return;

        var baseVisible = Params.VisibleSize ?? RoundToLot(Params.TotalSize * 0.10m);
        var variance = Params.VisibleVariancePct ?? 20m;
        if (_detectionRiskScore > 60) variance = Math.Min(variance * 1.5m, 50m);

        var factor = 1m + ((decimal)_rng.NextDouble() * 2 - 1) * variance / 100m;
        _visibleSize = RoundToLot(Math.Min(baseVisible * factor, RemainingSize));
        if (_visibleSize <= 0) { Status = AlgoStatus.Completed; return; }

        if (Math.Abs(_visibleSize - _lastVisibleSize) < Params.LotSize)
            _detectionRiskScore = Math.Min(100, _detectionRiskScore + 10);
        else
            _detectionRiskScore = Math.Max(0, _detectionRiskScore - 5);
        _lastVisibleSize = _visibleSize;

        var limitPrice = Params.LimitPrice ?? (Params.Side.ToUpper() == "BUY"
            ? RoundToTick(CurrentBid) : RoundToTick(CurrentAsk));
        if (limitPrice <= 0) { ScheduleRefresh(); return; }

        _activeClientId = NewClientOrderId();
        _orderActive = true;
        await SubmitOrderAsync(new OrderIntent(StrategyId, _activeClientId, Params.Exchange, Params.Symbol,
            Params.Side.ToUpper(), "LIMIT", _visibleSize, limitPrice, null, "GTC", Tag: "iceberg_slice"));
    }

    private void ScheduleRefresh()
    {
        _nextRefreshAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + _rng.Next(500, 3001);
        _orderActive = false;
    }

    protected override void OnFillReceived(AlgoFill fill)
    {
        _orderActive = false; _activeClientId = null;
        if (RemainingSize > 0) ScheduleRefresh();
    }

    protected override void OnRejectionReceived(string cid, string reason)
    {
        _orderActive = false; _activeClientId = null;
        _retryAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 2000;
    }

    protected override string? GetSummaryLine()
        => $"{Params.Side} {Params.TotalSize} {Params.Symbol} via ICEBERG | visible={Params.VisibleSize}";
}
