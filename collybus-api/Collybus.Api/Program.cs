using Collybus.Api.Adapters;
using Collybus.Api.Hubs;
using Collybus.Api.Models;
using Collybus.Api.Services;
using Collybus.Api.Services.Stubs;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers()
    .AddJsonOptions(o =>
    {
        o.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        o.JsonSerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
    });

builder.Services.AddSignalR()
    .AddJsonProtocol(o =>
    {
        o.PayloadSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
        o.PayloadSerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
    });
builder.Services.AddOpenApi();

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173", "http://localhost:3000")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));

// Services
builder.Services.AddSingleton<IBlotterService, StubBlotterService>();
builder.Services.AddSingleton<IRiskService, StubRiskService>();
builder.Services.AddSingleton<IKeyStore, KeyStore>();

// Algo engine
builder.Services.AddSingleton<Collybus.Algo.Ports.IOrderPort, Collybus.Api.Adapters.AlgoOrderPort>();
builder.Services.AddSingleton<Collybus.Algo.Ports.IAlgoEventBus, Collybus.Api.Adapters.AlgoEventBus>();
builder.Services.AddSingleton<Collybus.Algo.Engine.IStrategyFactory, Collybus.Algo.Engine.StrategyFactory>();
builder.Services.AddSingleton<Collybus.Algo.Engine.AlgoEngine>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<Collybus.Algo.Engine.AlgoEngine>());

// Exchange adapters — register as both concrete type and IExchangeAdapter
builder.Services.AddSingleton<DeribitAdapter>(sp => new DeribitAdapter(
    sp.GetRequiredService<ILogger<DeribitAdapter>>(),
    sp.GetRequiredService<IHubContext<CollybusHub>>(),
    sp.GetRequiredService<IBlotterService>(),
    testnet: true
));
builder.Services.AddSingleton<IExchangeAdapter>(sp => sp.GetRequiredService<DeribitAdapter>());

builder.Services.AddSingleton<BitmexAdapter>(sp => new BitmexAdapter(
    sp.GetRequiredService<ILogger<BitmexAdapter>>(),
    sp.GetRequiredService<IHubContext<CollybusHub>>(),
    testnet: true
));
builder.Services.AddSingleton<IExchangeAdapter>(sp => sp.GetRequiredService<BitmexAdapter>());

// Order service — routes to exchange adapters
builder.Services.AddSingleton<IOrderService, RealOrderService>();

var app = builder.Build();

if (app.Environment.IsDevelopment())
    app.MapOpenApi();

app.UseCors();
app.UseAuthorization();
app.MapControllers();
app.MapHub<CollybusHub>("/hub");

// Wire fill routing: adapter fills → algo engine
{
    var algoEngine = app.Services.GetRequiredService<Collybus.Algo.Engine.AlgoEngine>();
    var algoOrderPort = app.Services.GetRequiredService<Collybus.Algo.Ports.IOrderPort>() as Collybus.Api.Adapters.AlgoOrderPort;
    var exchangeAdapters = app.Services.GetRequiredService<IEnumerable<IExchangeAdapter>>();

    foreach (var adapter in exchangeAdapters)
    {
        if (adapter is BaseExchangeAdapter baseAdapter)
        {
            baseAdapter.OnAlgoFill = fill =>
            {
                if (algoOrderPort == null) return;
                // Resolve venue order ID to (clientOrderId, strategyId)
                var resolved = algoOrderPort.ResolveVenueOrderId(fill.OrderId);
                if (resolved == null) return; // Not an algo order

                var (clientOrderId, strategyId) = resolved.Value;
                var algoFill = new Collybus.Algo.Models.AlgoFill(
                    StrategyId: strategyId,
                    ClientOrderId: clientOrderId,
                    ExchangeOrderId: fill.FillId,
                    FillPrice: fill.FillPrice,
                    FillSize: fill.FillSize,
                    Commission: fill.Commission,
                    Timestamp: fill.FillTs
                );
                _ = algoEngine.PushFillAsync(algoFill);
            };

            // Feed ticker updates to algo engine as market data
            baseAdapter.OnTickerUpdate = (venue, symbol, ticker) =>
            {
                if (ticker.BestBid <= 0 || ticker.BestAsk <= 0) return;
                var mid = (ticker.BestBid + ticker.BestAsk) / 2;
                var spreadBps = mid > 0 ? (ticker.BestAsk - ticker.BestBid) / mid * 10000 : 0;
                _ = algoEngine.PushMarketDataAsync(new Collybus.Algo.Models.MarketDataPoint(
                    Exchange: venue,
                    Symbol: symbol,
                    Bid: ticker.BestBid,
                    Ask: ticker.BestAsk,
                    Mid: mid,
                    SpreadBps: spreadBps,
                    LastTrade: ticker.LastPrice,
                    LastTradeSize: 0,
                    Timestamp: ticker.Timestamp
                ));
            };

            // Feed public market trades to algo engine (for VWAP, POV, IS)
            baseAdapter.OnTradeUpdate = (venue, symbol, price, size, direction, ts) =>
            {
                _ = algoEngine.PushMarketDataAsync(new Collybus.Algo.Models.MarketDataPoint(
                    Exchange: venue,
                    Symbol: symbol,
                    Bid: 0, Ask: 0, Mid: 0, SpreadBps: 0,
                    LastTrade: price,
                    LastTradeSize: size,
                    Timestamp: ts
                ));
            };
        }
    }
}

// Auto-connect private channels for saved keys with status "ok"
app.Lifetime.ApplicationStarted.Register(() => Task.Run(async () =>
{
    await Task.Delay(5000); // Wait for adapters to connect
    try
    {
        var keyStore = app.Services.GetRequiredService<IKeyStore>();
        var adapters = app.Services.GetRequiredService<IEnumerable<IExchangeAdapter>>();
        var verifiedKeys = keyStore.ListKeys().Where(k => k.Status == "ok");

        foreach (var safe in verifiedKeys)
        {
            try
            {
                var key = keyStore.GetKey(safe.Exchange, safe.Label);
                if (key == null) continue;

                var adapter = adapters.FirstOrDefault(a =>
                    a.Venue.Equals(safe.Exchange, StringComparison.OrdinalIgnoreCase));
                if (adapter == null) continue;

                await adapter.ConnectAsync();
                await adapter.SubscribePrivateAsync(new ExchangeCredentials
                {
                    Exchange = key.Exchange,
                    Fields = key.Fields,
                    Testnet = key.Testnet,
                });
                Console.WriteLine($"[Startup] Auto-connected {safe.Exchange} ({safe.Label})");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Startup] Failed to auto-connect {safe.Exchange}: {ex.Message}");
            }
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[Startup] Auto-connect error: {ex.Message}");
    }
}));

app.Run();
