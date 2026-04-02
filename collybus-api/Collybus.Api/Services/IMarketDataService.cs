using Collybus.Api.Models;

namespace Collybus.Api.Services;

public interface IMarketDataService
{
    Task StartAsync(CancellationToken ct = default);
    Ticker? GetTicker(string exchange, string symbol);
    OrderBook? GetOrderBook(string exchange, string symbol);
    IReadOnlyList<InstrumentSpec> GetInstruments(string exchange);
}
