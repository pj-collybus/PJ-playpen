using Collybus.Api.Models;

namespace Collybus.Api.Services.Stubs;

public class StubRiskService : IRiskService
{
    public RiskCheckResult Check(RiskCheckRequest request) => new()
    {
        Approved = true,
        NotionalValue = request.Quantity * (request.LimitPrice ?? request.ArrivalMid),
    };

    public RiskHeadroom GetHeadroom(string symbol, string exchange, string? accountId = null) => new()
    {
        PositionHeadroom = 1_000_000,
        PositionUnit = "USD",
        MaxPositionSize = 1_000_000,
        CurrentPosition = 0,
        NotionalHeadroom = 10_000_000,
        MaxTotalNotional = 10_000_000,
    };
}
