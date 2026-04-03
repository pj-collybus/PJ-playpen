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

// Auto-connect private channels for saved keys with status "ok"
app.Lifetime.ApplicationStarted.Register(() => Task.Run(async () =>
{
    await Task.Delay(2000); // Wait for hub to be ready
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
