using Collybus.Algo.Models;

namespace Collybus.Algo.Tca;

public static class TcaCalculator
{
    public static decimal ArrivalSlippage(decimal avgFillPrice, decimal arrivalMid, string side)
    {
        if (arrivalMid <= 0 || avgFillPrice <= 0) return 0;
        var diff = side.ToUpper() == "BUY"
            ? avgFillPrice - arrivalMid
            : arrivalMid - avgFillPrice;
        return diff / arrivalMid * 10000m;
    }

    public static decimal VwapShortfall(decimal avgFillPrice, decimal marketVwap, string side)
    {
        if (marketVwap <= 0 || avgFillPrice <= 0) return 0;
        var diff = side.ToUpper() == "BUY"
            ? avgFillPrice - marketVwap
            : marketVwap - avgFillPrice;
        return diff / marketVwap * 10000m;
    }

    public static decimal MarketImpact(decimal firstFillPrice, decimal lastFillPrice, string side)
    {
        if (firstFillPrice <= 0 || lastFillPrice <= 0) return 0;
        var drift = side.ToUpper() == "BUY"
            ? lastFillPrice - firstFillPrice
            : firstFillPrice - lastFillPrice;
        return drift / firstFillPrice * 10000m;
    }

    public static decimal AllInCost(decimal slippageBps, decimal feeBps, decimal spreadBps)
        => slippageBps + feeBps + spreadBps / 2m;

    public static TcaResult Calculate(
        decimal avgFillPrice, decimal arrivalMid, decimal marketVwap,
        decimal firstFillPrice, decimal lastFillPrice,
        string side, decimal feeBps, decimal spreadBps)
    {
        var slip = ArrivalSlippage(avgFillPrice, arrivalMid, side);
        var vwap = VwapShortfall(avgFillPrice, marketVwap, side);
        var impact = MarketImpact(firstFillPrice, lastFillPrice, side);
        var allIn = AllInCost(slip, feeBps, spreadBps);
        return new TcaResult(slip, vwap, impact, allIn);
    }
}
