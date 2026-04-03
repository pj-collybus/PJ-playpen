using Collybus.Algo.Models;

namespace Collybus.Algo.Ports;

public interface IOrderPort
{
    Task<string> SubmitAsync(OrderIntent intent);
    Task<bool> CancelAsync(string exchange, string orderId);
    Task<bool> AmendAsync(string exchange, string orderId, decimal? newQty, decimal? newPrice);
}
