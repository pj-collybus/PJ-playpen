using Collybus.Api.Models;
using Collybus.Api.Services;

namespace Collybus.Api.Adapters;

public interface IExchangeAdapter
{
    string Venue { get; }
    Task ConnectAsync(CancellationToken ct = default);
    Task SubscribeAsync(string venueSymbol);
    Task UnsubscribeAsync(string venueSymbol);
    Task SubscribePrivateAsync(ExchangeCredentials credentials);
    Task<OrderResult> SubmitOrderAsync(SubmitOrderRequest request, ExchangeCredentials credentials);
    Task<OrderResult> CancelOrderAsync(string venueOrderId, ExchangeCredentials credentials);
    Task<OrderResult> AmendOrderAsync(string orderId, decimal? newQty, decimal? newPrice, ExchangeCredentials credentials);
    void Disconnect();
}

public record OrderResult
{
    public bool Ok { get; init; }
    public string? VenueOrderId { get; init; }
    public string? ClientOrderId { get; init; }
    public string Status { get; init; } = "";
    public decimal FilledQty { get; init; }
    public decimal AvgFillPrice { get; init; }
    public string? RejectReason { get; init; }
}
