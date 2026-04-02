using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Collybus.Api.Models;

namespace Collybus.Api.Services;

public class KeyStore : IKeyStore
{
    private readonly string _storePath;
    private readonly ILogger<KeyStore> _logger;
    private readonly HttpClient _http = new();
    private byte[]? _encKey;

    private static readonly Dictionary<string, string[]> SecretFields = new()
    {
        ["Deribit"] = ["clientSecret"],
        ["Binance"] = ["secretKey"],
        ["OKX"]     = ["secretKey", "passphrase"],
        ["Bybit"]   = ["secretKey"],
        ["Kraken"]  = ["privateKey"],
        ["BitMEX"]  = ["apiSecret"],
    };

    public bool IsReady => _encKey != null;

    public KeyStore(IConfiguration config, ILogger<KeyStore> logger)
    {
        _logger = logger;
        _storePath = config["KeyStore:Path"] ?? Path.Combine(AppContext.BaseDirectory, "keys_store.json");

        var keyHex = config["ENCRYPTION_KEY"] ?? Environment.GetEnvironmentVariable("ENCRYPTION_KEY");
        if (!string.IsNullOrEmpty(keyHex) && keyHex.Length == 64)
        {
            _encKey = Convert.FromHexString(keyHex);
            _logger.LogInformation("[KeyStore] Encryption key loaded, store at {Path}", _storePath);
        }
        else
        {
            _logger.LogWarning("[KeyStore] ENCRYPTION_KEY not configured — key storage disabled");
        }
    }

    public KeyEntry? GetKey(string exchange, string? label = null)
    {
        var store = LoadStore();
        var exUp = exchange.ToUpperInvariant();
        var entry = label != null
            ? store.Keys.FirstOrDefault(k => k.Exchange.ToUpperInvariant() == exUp && k.Label == label)
            : store.Keys.FirstOrDefault(k => k.Exchange.ToUpperInvariant() == exUp);
        if (entry == null) return null;
        return new KeyEntry
        {
            Id = entry.Id,
            Exchange = entry.Exchange,
            Label = entry.Label,
            Testnet = entry.Testnet,
            Permissions = entry.Permissions,
            Fields = DecryptFields(entry.Fields),
        };
    }

    public KeyEntry? GetKeyById(string id)
    {
        var store = LoadStore();
        var entry = store.Keys.FirstOrDefault(k => k.Id == id);
        if (entry == null) return null;
        return new KeyEntry
        {
            Id = entry.Id,
            Exchange = entry.Exchange,
            Label = entry.Label,
            Testnet = entry.Testnet,
            Permissions = entry.Permissions,
            Fields = DecryptFields(entry.Fields),
        };
    }

    public IReadOnlyList<KeyEntrySafe> ListKeys()
    {
        var store = LoadStore();
        return store.Keys.Select(entry =>
        {
            var safeFields = new Dictionary<string, string?>();
            var secrets = SecretFields.GetValueOrDefault(entry.Exchange, []);
            foreach (var (k, v) in entry.Fields)
            {
                if (secrets.Contains(k)) safeFields[k] = null;
                else { try { safeFields[k] = Decrypt(v); } catch { safeFields[k] = null; } }
            }
            return new KeyEntrySafe
            {
                Id = entry.Id,
                Exchange = entry.Exchange,
                Label = entry.Label,
                Testnet = entry.Testnet,
                Permissions = entry.Permissions,
                Status = entry.Status,
                LastTested = entry.LastTested,
                Fields = safeFields,
            };
        }).ToList();
    }

    public SaveKeyResult SaveKey(SaveKeyRequest request)
    {
        if (!IsReady) throw new InvalidOperationException("ENCRYPTION_KEY not configured");
        if (string.IsNullOrEmpty(request.Exchange)) throw new ArgumentException("exchange required");
        if (string.IsNullOrEmpty(request.Label)) throw new ArgumentException("label required");

        var store = LoadStore();
        var entry = request.Id != null
            ? store.Keys.FirstOrDefault(k => k.Id == request.Id)
            : null;

        if (entry == null)
        {
            entry = new StoreEntry
            {
                Id = Guid.NewGuid().ToString(),
                Exchange = request.Exchange,
                Label = request.Label,
                Fields = [],
                Permissions = "read",
                Testnet = false,
                Status = "unknown",
            };
            store.Keys.Add(entry);
        }

        entry.Label = request.Label;
        entry.Permissions = request.Permissions;
        entry.Testnet = request.Testnet;
        entry.Exchange = request.Exchange;
        entry.Status = "unknown";

        foreach (var (k, v) in request.Fields)
        {
            if (string.IsNullOrEmpty(v)) continue;
            entry.Fields[k] = Encrypt(v);
        }

        SaveStore(store);
        return new SaveKeyResult { Ok = true, Id = entry.Id };
    }

    public void DeleteKey(string id)
    {
        var store = LoadStore();
        var idx = store.Keys.FindIndex(k => k.Id == id);
        if (idx < 0) throw new KeyNotFoundException("Key not found");
        store.Keys.RemoveAt(idx);
        SaveStore(store);
    }

    public async Task<TestKeyResult> TestKeyAsync(string id)
    {
        var store = LoadStore();
        var entry = store.Keys.FirstOrDefault(k => k.Id == id)
            ?? throw new KeyNotFoundException("Key not found");

        var fields = DecryptFields(entry.Fields);
        try
        {
            var message = await TestConnectionAsync(entry.Exchange, fields, entry.Testnet);
            entry.Status = "ok";
            entry.LastTested = DateTime.UtcNow.ToString("O");
            SaveStore(store);
            return new TestKeyResult { Ok = true, Message = message };
        }
        catch (Exception ex)
        {
            entry.Status = "error";
            entry.LastTested = DateTime.UtcNow.ToString("O");
            SaveStore(store);
            throw new Exception(ex.Message);
        }
    }

    // ── Encryption (AES-256-GCM) ──────────────────────────────────────────────

    private string Encrypt(string plaintext)
    {
        if (_encKey == null) throw new InvalidOperationException("No encryption key");
        var iv = RandomNumberGenerator.GetBytes(12);
        using var aes = new AesGcm(_encKey, 16);
        var plainBytes = Encoding.UTF8.GetBytes(plaintext);
        var cipherBytes = new byte[plainBytes.Length];
        var tag = new byte[16];
        aes.Encrypt(iv, plainBytes, cipherBytes, tag);
        return $"{Convert.ToHexString(iv).ToLower()}:{Convert.ToHexString(tag).ToLower()}:{Convert.ToHexString(cipherBytes).ToLower()}";
    }

    private string Decrypt(string ciphertext)
    {
        if (_encKey == null) throw new InvalidOperationException("No encryption key");
        var parts = ciphertext.Split(':');
        if (parts.Length != 3) throw new FormatException("Invalid ciphertext format");
        var iv = Convert.FromHexString(parts[0]);
        var tag = Convert.FromHexString(parts[1]);
        var cipher = Convert.FromHexString(parts[2]);
        using var aes = new AesGcm(_encKey, 16);
        var plain = new byte[cipher.Length];
        aes.Decrypt(iv, cipher, tag, plain);
        return Encoding.UTF8.GetString(plain);
    }

    private Dictionary<string, string> DecryptFields(Dictionary<string, string> encrypted)
    {
        var result = new Dictionary<string, string>();
        foreach (var (k, v) in encrypted)
        {
            try { result[k] = Decrypt(v); }
            catch { throw new Exception("Decryption failed — is ENCRYPTION_KEY unchanged?"); }
        }
        return result;
    }

    // ── Store I/O ─────────────────────────────────────────────────────────────

    private KeyStoreFile LoadStore()
    {
        try
        {
            if (File.Exists(_storePath))
            {
                var json = File.ReadAllText(_storePath);
                return JsonSerializer.Deserialize<KeyStoreFile>(json,
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                    ?? new KeyStoreFile();
            }
        }
        catch (Exception ex) { _logger.LogError(ex, "Failed to read key store"); }
        return new KeyStoreFile();
    }

    private void SaveStore(KeyStoreFile store)
    {
        var json = JsonSerializer.Serialize(store, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(_storePath, json);
    }

    // ── Connection tests ──────────────────────────────────────────────────────

    private async Task<string> TestConnectionAsync(string exchange, Dictionary<string, string> fields, bool testnet)
    {
        return exchange switch
        {
            "Deribit" => await TestDeribitAsync(fields, testnet),
            "BitMEX"  => await TestBitmexAsync(fields, testnet),
            _ => throw new Exception($"Unknown exchange: {exchange}"),
        };
    }

    private async Task<string> TestDeribitAsync(Dictionary<string, string> f, bool testnet)
    {
        var base_ = testnet ? "https://test.deribit.com/api/v2" : "https://www.deribit.com/api/v2";
        var url = $"{base_}/public/auth?client_id={Uri.EscapeDataString(f["clientId"])}&client_secret={Uri.EscapeDataString(f["clientSecret"])}&grant_type=client_credentials";
        var r = await _http.GetAsync(url);
        var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
        if (j.RootElement.TryGetProperty("error", out _))
            throw new Exception(j.RootElement.GetProperty("error").GetProperty("message").GetString());
        return $"Connected to Deribit{(testnet ? " (testnet)" : "")}";
    }

    private async Task<string> TestBitmexAsync(Dictionary<string, string> f, bool testnet)
    {
        var base_ = testnet ? "https://testnet.bitmex.com" : "https://www.bitmex.com";
        var expires = ((DateTimeOffset.UtcNow.ToUnixTimeSeconds()) + 60).ToString();
        var sigData = $"GET/api/v1/user/margin{expires}";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(f["apiSecret"]));
        var sig = Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(sigData))).ToLower();
        var req = new HttpRequestMessage(HttpMethod.Get, $"{base_}/api/v1/user/margin");
        req.Headers.Add("api-key", f["apiKey"]);
        req.Headers.Add("api-signature", sig);
        req.Headers.Add("api-expires", expires);
        var r = await _http.SendAsync(req);
        var j = JsonDocument.Parse(await r.Content.ReadAsStringAsync());
        if (j.RootElement.TryGetProperty("error", out var err))
            throw new Exception(err.GetProperty("message").GetString());
        return $"Connected to BitMEX{(testnet ? " (testnet)" : "")}";
    }

    // ── Internal types ────────────────────────────────────────────────────────

    private class KeyStoreFile
    {
        public List<StoreEntry> Keys { get; set; } = [];
    }

    private class StoreEntry
    {
        public string Id { get; set; } = "";
        public string Exchange { get; set; } = "";
        public string Label { get; set; } = "";
        public Dictionary<string, string> Fields { get; set; } = [];
        public string Permissions { get; set; } = "read";
        public bool Testnet { get; set; }
        public string Status { get; set; } = "unknown";
        public string? LastTested { get; set; }
    }
}
