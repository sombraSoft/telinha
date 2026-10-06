using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Telinha.Tray
{
    /// <summary>A failed control call, as one line.</summary>
    public sealed class ControlException : Exception
    {
        public ControlException(string message) : base(message)
        {
        }
    }

    /// <summary>
    /// The running service's local control endpoint (/internal/* on LISTEN), with the
    /// bearer token from data\run\control.token, read per call because every start
    /// writes a fresh one. Nothing is retried here; callers decide.
    /// </summary>
    public sealed class ControlClient : IDisposable
    {
        public const string DefaultListen = "127.0.0.1:8081";
        public const int StatusTimeoutMs = 5000;
        public const int ShutdownTimeoutMs = 10000;
        // The service downloads and stages synchronously: allow a slow link.
        public const int UpdateTimeoutMs = 6 * 60 * 1000;

        private static readonly Regex TokenRe = new Regex(@"^[0-9a-f]{64}\z", RegexOptions.CultureInvariant);
        private static readonly Regex BracketListen = new Regex(@"^\[([^\]]+)\]:([0-9]+)\z", RegexOptions.CultureInvariant);
        private static readonly Regex PlainListen = new Regex(@"^([^:\[\]]+):([0-9]+)\z", RegexOptions.CultureInvariant);

        private readonly HttpClient http;
        private readonly Func<string> listen;
        private readonly string tokenFile;

        /// <param name="listen">LISTEN from the merged env, asked per call so an edited telinha.env applies.</param>
        public ControlClient(Func<string> listen, string tokenFile, HttpMessageHandler handler = null)
        {
            this.listen = listen ?? (() => null);
            this.tokenFile = tokenFile;
            // A system proxy must never see the token: the endpoint is local.
            http = new HttpClient(handler ?? new HttpClientHandler { UseProxy = false }, true)
            {
                Timeout = Timeout.InfiniteTimeSpan,
            };
            http.DefaultRequestHeaders.ExpectContinue = false;
        }

        /// <summary>http://host:port for a LISTEN value; the wildcard binds mean loopback, IPv6 is bracketed.</summary>
        public static string BaseUrl(string listenValue)
        {
            string host;
            int port;
            if (!TryParseListen(string.IsNullOrEmpty(listenValue) ? DefaultListen : listenValue, out host, out port))
            {
                TryParseListen(DefaultListen, out host, out port);
            }
            return "http://" + UpstreamHost(host) + ":" + port.ToString(CultureInfo.InvariantCulture);
        }

        private static bool TryParseListen(string v, out string host, out int port)
        {
            host = null;
            port = 0;
            var m = BracketListen.Match(v);
            if (!m.Success) m = PlainListen.Match(v);
            if (!m.Success) return false;
            var digits = m.Groups[2].Value;
            long p;
            if (digits.Length > 6 || !long.TryParse(digits, NumberStyles.None, CultureInfo.InvariantCulture, out p) || p < 1 || p > 65535) return false;
            host = m.Groups[1].Value;
            port = (int)p;
            return true;
        }

        private static string UpstreamHost(string host)
        {
            if (host == "" || host == "0.0.0.0" || host == "::") return "127.0.0.1";
            return host.Contains(":") ? "[" + host + "]" : host;
        }

        /// <summary>What the service writes: 32 random bytes in hex. Anything else is never sent.</summary>
        public static bool IsToken(string s)
        {
            return s != null && TokenRe.IsMatch(s);
        }

        /// <summary>The token, or null when the file is missing or holds something else.</summary>
        public static string ReadToken(string path)
        {
            try
            {
                var t = EnvFile.Trim(File.ReadAllText(path));
                return IsToken(t) ? t : null;
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is ArgumentException || e is NotSupportedException)
            {
                return null;
            }
        }

        /// <summary>GET /internal/status; null when the service is not running or does not answer.</summary>
        public Status Status()
        {
            try
            {
                return Tray.Status.Parse(Send("GET", "/internal/status", null, StatusTimeoutMs, null));
            }
            catch (ControlException)
            {
                return null;
            }
        }

        /// <summary>POST /internal/shutdown; the service answers 202 before it goes away.</summary>
        public void Shutdown(string reason)
        {
            Send("POST", "/internal/shutdown", new Dictionary<string, object> { { "reason", reason } }, ShutdownTimeoutMs, 202);
        }

        /// <summary>POST /internal/update with mode check or now.</summary>
        public UpdateResult Update(string mode)
        {
            var text = Send("POST", "/internal/update", new Dictionary<string, object> { { "mode", mode } }, UpdateTimeoutMs, null);
            var r = UpdateResult.Parse(text);
            if (r == null) throw new ControlException("control: POST /internal/update: unreadable answer");
            return r;
        }

        private string Send(string method, string path, object body, int timeoutMs, int? expect)
        {
            var token = ReadToken(tokenFile);
            if (token == null) throw new ControlException("telinha is not running (no control token)");
            Uri url;
            if (!Uri.TryCreate(BaseUrl(listen()) + path, UriKind.Absolute, out url)) throw new ControlException("control: LISTEN is not a usable address");
            using (var req = new HttpRequestMessage(new HttpMethod(method), url))
            using (var cts = new CancellationTokenSource(timeoutMs))
            {
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                if (body != null) req.Content = new StringContent(Json.Serialize(body), new UTF8Encoding(false), "application/json");
                HttpResponseMessage res;
                string text;
                try
                {
                    res = http.SendAsync(req, cts.Token).ConfigureAwait(false).GetAwaiter().GetResult();
                    text = res.Content == null ? "" : res.Content.ReadAsStringAsync().ConfigureAwait(false).GetAwaiter().GetResult();
                }
                catch (OperationCanceledException)
                {
                    throw new ControlException("control: " + method + " " + path + ": no answer in " + (timeoutMs / 1000).ToString(CultureInfo.InvariantCulture) + " s");
                }
                catch (Exception e) when (e is HttpRequestException || e is IOException || e is InvalidOperationException)
                {
                    throw new ControlException("control: " + method + " " + path + ": " + Innermost(e).Message);
                }
                using (res)
                {
                    var code = (int)res.StatusCode;
                    var ok = expect.HasValue ? code == expect.Value : res.IsSuccessStatusCode;
                    if (!ok)
                    {
                        // The server's own words when it gave some ({"error": ...}).
                        var error = Json.Str(Json.Object(text), "error");
                        throw new ControlException(!string.IsNullOrEmpty(error)
                            ? error
                            : ("control: " + method + " " + path + ": " + code.ToString(CultureInfo.InvariantCulture) + " " + res.ReasonPhrase).Trim());
                    }
                    return text;
                }
            }
        }

        private static Exception Innermost(Exception e)
        {
            while (e.InnerException != null) e = e.InnerException;
            return e;
        }

        public void Dispose()
        {
            http.Dispose();
        }
    }
}
