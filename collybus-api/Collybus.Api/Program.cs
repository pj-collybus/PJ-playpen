using Collybus.Api.Adapters;
using Collybus.Api.Hubs;
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

builder.Services.AddSignalR();
builder.Services.AddOpenApi();

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173", "http://localhost:3000")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));

// Services — stubs for now, will be replaced with real implementations
builder.Services.AddSingleton<IOrderService, StubOrderService>();
builder.Services.AddSingleton<IBlotterService, StubBlotterService>();
builder.Services.AddSingleton<IAlgoService, StubAlgoService>();
builder.Services.AddSingleton<IRiskService, StubRiskService>();
builder.Services.AddSingleton<IKeyStore, KeyStore>();

// Exchange adapters
builder.Services.AddSingleton<DeribitAdapter>(sp => new DeribitAdapter(
    sp.GetRequiredService<ILogger<DeribitAdapter>>(),
    sp.GetRequiredService<IHubContext<CollybusHub>>(),
    sp.GetRequiredService<IBlotterService>(),
    testnet: true
));
builder.Services.AddSingleton<BitmexAdapter>(sp => new BitmexAdapter(
    sp.GetRequiredService<ILogger<BitmexAdapter>>(),
    sp.GetRequiredService<IHubContext<CollybusHub>>(),
    testnet: true
));

var app = builder.Build();

if (app.Environment.IsDevelopment())
    app.MapOpenApi();

app.UseCors();
app.UseAuthorization();
app.MapControllers();
app.MapHub<CollybusHub>("/hub");

app.Run();
