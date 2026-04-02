using System.Text.Json.Serialization;

namespace Collybus.Api.Models;

public record Ticker
{
    public string Symbol { get; init; } = "";
    public string Exchange { get; init; } = "";
    public decimal BestBid { get; init; }
    public decimal BestAsk { get; init; }
    public decimal LastPrice { get; init; }
    public decimal MarkPrice { get; init; }
    public decimal IndexPrice { get; init; }
    public decimal Volume24h { get; init; }
    public decimal High24h { get; init; }
    public decimal Low24h { get; init; }
    public decimal Change24h { get; init; }
    public decimal OpenInterest { get; init; }
    public decimal? FundingRate { get; init; }
    public long Timestamp { get; init; }
}

public record OrderBookLevel(decimal Price, decimal Size);

public record OrderBook
{
    public string Symbol { get; init; } = "";
    public string Exchange { get; init; } = "";
    public List<OrderBookLevel> Bids { get; init; } = [];
    public List<OrderBookLevel> Asks { get; init; } = [];
    public long Timestamp { get; init; }
}

public record InstrumentSpec
{
    public string Symbol { get; init; } = "";
    public string Exchange { get; init; } = "";
    public decimal TickSize { get; init; }
    public decimal LotSize { get; init; }
    public string ContractType { get; init; } = "";
    public string BaseCurrency { get; init; } = "";
    public string QuoteCurrency { get; init; } = "";
    public string SettleCurrency { get; init; } = "";
    public decimal MinOrderSize { get; init; }
    public decimal MaxOrderSize { get; init; }
}
