namespace Collybus.Api.Config;

public record VenueDefinition
{
    public string Id { get; init; } = "";
    public string DisplayName { get; init; } = "";
    public string WsUrl { get; init; } = "";
    public string WsUrlTestnet { get; init; } = "";
    public string RestBase { get; init; } = "";
    public string RestBaseTestnet { get; init; } = "";
    public string ExchangeColor { get; init; } = "#888888";
    public string ExchangeBg { get; init; } = "#1a1a1a";
    public string ExchangeText { get; init; } = "";
    public string FeedType { get; init; } = "WEBSOCKET";
    public string[] AssetClasses { get; init; } = [];
    public bool SupportsTestnet { get; init; }
}

public static class Venues
{
    public static readonly Dictionary<string, VenueDefinition> All = new()
    {
        ["DERIBIT"] = new()
        {
            Id = "DERIBIT", DisplayName = "Deribit",
            WsUrl = "wss://www.deribit.com/ws/api/v2",
            WsUrlTestnet = "wss://test.deribit.com/ws/api/v2",
            RestBase = "https://www.deribit.com",
            RestBaseTestnet = "https://test.deribit.com",
            ExchangeColor = "#e03040", ExchangeBg = "#2a080e", ExchangeText = "D",
            FeedType = "WEBSOCKET",
            AssetClasses = ["CRYPTO_PERP", "CRYPTO_FUTURE", "CRYPTO_OPTION", "CRYPTO_SPOT"],
            SupportsTestnet = true,
        },
        ["BINANCE"] = new()
        {
            Id = "BINANCE", DisplayName = "Binance",
            WsUrl = "wss://stream.binance.com:9443/ws",
            WsUrlTestnet = "wss://testnet.binance.vision/ws",
            RestBase = "https://api.binance.com",
            RestBaseTestnet = "https://testnet.binance.vision",
            ExchangeColor = "#f0b90b", ExchangeBg = "#2a2008", ExchangeText = "B",
            FeedType = "WEBSOCKET",
            AssetClasses = ["CRYPTO_SPOT", "CRYPTO_PERP", "CRYPTO_FUTURE"],
            SupportsTestnet = true,
        },
        ["BYBIT"] = new()
        {
            Id = "BYBIT", DisplayName = "Bybit",
            WsUrl = "wss://stream.bybit.com/v5/public/linear",
            WsUrlTestnet = "wss://stream-testnet.bybit.com/v5/public/linear",
            RestBase = "https://api.bybit.com",
            RestBaseTestnet = "https://api-testnet.bybit.com",
            ExchangeColor = "#f7a600", ExchangeBg = "#2a1e08", ExchangeText = "By",
            FeedType = "WEBSOCKET",
            AssetClasses = ["CRYPTO_SPOT", "CRYPTO_PERP", "CRYPTO_FUTURE"],
            SupportsTestnet = true,
        },
        ["OKX"] = new()
        {
            Id = "OKX", DisplayName = "OKX",
            WsUrl = "wss://ws.okx.com:8443/ws/v5/public",
            WsUrlTestnet = "wss://wspap.okx.com:8443/ws/v5/public?brokerId=9999",
            RestBase = "https://www.okx.com",
            RestBaseTestnet = "https://www.okx.com",
            ExchangeColor = "#aaaaaa", ExchangeBg = "#1a1a1a", ExchangeText = "OX",
            FeedType = "WEBSOCKET",
            AssetClasses = ["CRYPTO_SPOT", "CRYPTO_PERP", "CRYPTO_FUTURE", "CRYPTO_OPTION"],
            SupportsTestnet = true,
        },
        ["KRAKEN"] = new()
        {
            Id = "KRAKEN", DisplayName = "Kraken",
            WsUrl = "wss://ws.kraken.com",
            WsUrlTestnet = "wss://demo-futures.kraken.com/derivatives",
            RestBase = "https://api.kraken.com",
            RestBaseTestnet = "https://demo-futures.kraken.com",
            ExchangeColor = "#8d5ff0", ExchangeBg = "#100820", ExchangeText = "Kr",
            FeedType = "WEBSOCKET",
            AssetClasses = ["CRYPTO_SPOT", "CRYPTO_PERP"],
            SupportsTestnet = true,
        },
        ["BITMEX"] = new()
        {
            Id = "BITMEX", DisplayName = "BitMEX",
            WsUrl = "wss://ws.bitmex.com/realtime",
            WsUrlTestnet = "wss://testnet.bitmex.com/realtime",
            RestBase = "https://www.bitmex.com",
            RestBaseTestnet = "https://testnet.bitmex.com",
            ExchangeColor = "#4a90d9", ExchangeBg = "#081420", ExchangeText = "BX",
            FeedType = "WEBSOCKET",
            AssetClasses = ["CRYPTO_PERP", "CRYPTO_FUTURE"],
            SupportsTestnet = true,
        },
        ["LMAX"] = new()
        {
            Id = "LMAX", DisplayName = "LMAX",
            WsUrl = "", WsUrlTestnet = "",
            RestBase = "", RestBaseTestnet = "",
            ExchangeColor = "#cc8844", ExchangeBg = "#1e1408", ExchangeText = "LX",
            FeedType = "FIX",
            AssetClasses = ["FX_SPOT"],
            SupportsTestnet = true,
        },
        ["EBS"] = new()
        {
            Id = "EBS", DisplayName = "EBS",
            WsUrl = "", WsUrlTestnet = "",
            RestBase = "", RestBaseTestnet = "",
            ExchangeColor = "#5588cc", ExchangeBg = "#081420", ExchangeText = "EB",
            FeedType = "FIX",
            AssetClasses = ["FX_SPOT"],
            SupportsTestnet = true,
        },
    };
}
