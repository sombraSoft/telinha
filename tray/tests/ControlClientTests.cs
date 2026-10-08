using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Telinha.Tray.Tests
{
    [TestClass]
    public class ControlClientTests
    {
        private const string Token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow

        private sealed class FakeHandler : HttpMessageHandler
        {
            public readonly List<HttpRequestMessage> Requests = new List<HttpRequestMessage>();
            public readonly List<string> Bodies = new List<string>();
            public Func<HttpRequestMessage, HttpResponseMessage> Answer = r => new HttpResponseMessage(HttpStatusCode.OK);

            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Requests.Add(request);
                Bodies.Add(request.Content == null ? null : request.Content.ReadAsStringAsync().Result);
                return Task.FromResult(Answer(request));
            }
        }

        private static HttpResponseMessage JsonResponse(HttpStatusCode code, string json)
        {
            return new HttpResponseMessage(code) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }

        private string dir;

        [TestInitialize]
        public void Setup()
        {
            dir = Path.Combine(Path.GetTempPath(), "telinha-tray-ctl-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
        }

        [TestCleanup]
        public void Cleanup()
        {
            Directory.Delete(dir, true);
        }

        private string TokenFile(string content)
        {
            var p = Path.Combine(dir, "control.token");
            if (content != null) File.WriteAllText(p, content);
            return p;
        }

        [TestMethod]
        public void BaseUrlMirrorsTheServer()
        {
            Assert.AreEqual("http://127.0.0.1:8081", ControlClient.BaseUrl(null));
            Assert.AreEqual("http://127.0.0.1:8081", ControlClient.BaseUrl(""));
            Assert.AreEqual("http://127.0.0.1:9000", ControlClient.BaseUrl("0.0.0.0:9000"));
            Assert.AreEqual("http://127.0.0.1:9000", ControlClient.BaseUrl("[::]:9000"));
            Assert.AreEqual("http://[::1]:8081", ControlClient.BaseUrl("[::1]:8081"));
            Assert.AreEqual("http://192.168.0.10:80", ControlClient.BaseUrl("192.168.0.10:80"));
            Assert.AreEqual("http://localhost:3000", ControlClient.BaseUrl("localhost:3000"));
        }

        [TestMethod]
        public void BadListenFallsBackToTheDefault()
        {
            foreach (var bad in new[] { "9000", "host:0", "host:65536", "host:99999999999", "::1:8081", "host:80\n", "host: 80" })
            {
                Assert.AreEqual("http://127.0.0.1:8081", ControlClient.BaseUrl(bad), bad);
            }
        }

        [TestMethod]
        public void TokenShape()
        {
            Assert.IsTrue(ControlClient.IsToken(Token));
            Assert.IsFalse(ControlClient.IsToken(Token.ToUpperInvariant()));
            Assert.IsFalse(ControlClient.IsToken(Token.Substring(1)));
            Assert.IsFalse(ControlClient.IsToken(Token + "0"));
            Assert.IsFalse(ControlClient.IsToken(null));
            Assert.AreEqual(Token, ControlClient.ReadToken(TokenFile(Token + "\r\n")));
            Assert.IsNull(ControlClient.ReadToken(TokenFile("not a token")));
            Assert.IsNull(ControlClient.ReadToken(Path.Combine(dir, "missing.token")));
        }

        [TestMethod]
        public void NoTokenMeansNotRunningAndNothingIsSent()
        {
            var handler = new FakeHandler();
            using (var c = new ControlClient(() => "127.0.0.1:8081", TokenFile("secret-looking-but-wrong"), handler))
            {
                Assert.IsNull(c.Status());
                var e = Assert.ThrowsExactly<ControlException>(() => c.Shutdown("stop"));
                StringAssert.Contains(e.Message, "not running");
            }
            Assert.AreEqual(0, handler.Requests.Count);
        }

        [TestMethod]
        public void StatusParsesTolerantly()
        {
            var handler = new FakeHandler
            {
                Answer = r => JsonResponse(HttpStatusCode.OK, @"{
                    ""version"": ""0.7.0"", ""startedAt"": 1700000000000, ""pid"": 42, ""rooms"": 2, ""supervised"": true,
                    ""children"": { ""livekit"": ""up"" },
                    ""childStatus"": { ""livekit"": { ""state"": ""restarting"", ""pid"": null, ""restarts"": 5, ""recentRestarts"": 3, ""since"": 1700000001000 } },
                    ""update"": { ""enabled"": true, ""current"": ""0.7.0"", ""latest"": ""v0.8.0"", ""pin"": null, ""staged"": { ""tag"": ""v0.8.0"" },
                                ""failed"": null, ""pending"": null, ""deferredSince"": null, ""lastCheck"": 1,
                                ""applied"": { ""tag"": ""v0.7.0"", ""previous"": ""0.6.0"", ""at"": 1700000000500 } },
                    ""somethingNew"": [1, 2, 3]
                }"),
            };
            using (var c = new ControlClient(() => "0.0.0.0:9000", TokenFile(Token), handler))
            {
                var s = c.Status();
                Assert.IsNotNull(s);
                Assert.AreEqual("0.7.0", s.Version);
                Assert.AreEqual(1700000000000L, s.StartedAt);
                Assert.AreEqual(2, s.Rooms);
                Assert.IsTrue(s.Supervised);
                Assert.AreEqual("up", s.Children["livekit"]);
                Assert.AreEqual(3, s.ChildStatus["livekit"].RecentRestarts);
                Assert.AreEqual(5, s.ChildStatus["livekit"].Restarts);
                Assert.IsNull(s.ChildStatus["livekit"].Pid);
                Assert.AreEqual("v0.8.0", s.Update.Latest);
                Assert.IsNull(s.Update.Pin);
                Assert.AreEqual("v0.8.0", s.Update.StagedTag);
                Assert.IsTrue(s.Update.HasApplied);
                Assert.AreEqual("v0.7.0", s.Update.Applied.Tag);
            }
            var req = handler.Requests[0];
            Assert.AreEqual("http://127.0.0.1:9000/internal/status", req.RequestUri.ToString());
            Assert.AreEqual(HttpMethod.Get, req.Method);
            Assert.AreEqual("Bearer " + Token, req.Headers.Authorization.ToString());
        }

        [TestMethod]
        public void OlderServersAndOddFieldsDoNotBreakIt()
        {
            var s = Status.Parse(@"{ ""version"": 7, ""rooms"": ""two"", ""childStatus"": { ""a"": 1 }, ""update"": { ""latest"": ""v1.0.0"", ""pin"": ""v0.9.0"" } }");
            Assert.IsNotNull(s);
            Assert.AreEqual("", s.Version);
            Assert.AreEqual(0, s.Rooms);
            Assert.AreEqual(0, s.ChildStatus.Count);
            Assert.AreEqual("v0.9.0", s.Update.Pin);
            Assert.IsFalse(s.Update.HasApplied);
            Assert.IsNull(s.Update.Applied);
            Assert.IsNull(Status.Parse("not json"));
            Assert.IsNull(Status.Parse("[1,2]"));
        }

        [TestMethod]
        public void UnreachableServiceIsNullStatus()
        {
            var handler = new FakeHandler { Answer = r => { throw new HttpRequestException("refused"); } };
            using (var c = new ControlClient(() => null, TokenFile(Token), handler))
            {
                Assert.IsNull(c.Status());
            }
            handler = new FakeHandler { Answer = r => new HttpResponseMessage(HttpStatusCode.NotFound) };
            using (var c = new ControlClient(() => null, TokenFile(Token), handler))
            {
                Assert.IsNull(c.Status());
            }
        }

        [TestMethod]
        public void ShutdownPostsTheReasonAndWants202()
        {
            var handler = new FakeHandler { Answer = r => new HttpResponseMessage(HttpStatusCode.Accepted) };
            using (var c = new ControlClient(() => null, TokenFile(Token), handler))
            {
                c.Shutdown("restart");
            }
            Assert.AreEqual(HttpMethod.Post, handler.Requests[0].Method);
            Assert.AreEqual("http://127.0.0.1:8081/internal/shutdown", handler.Requests[0].RequestUri.ToString());
            Assert.AreEqual("{\"reason\":\"restart\"}", handler.Bodies[0]);
            Assert.AreEqual("application/json", handler.Requests[0].Content.Headers.ContentType.MediaType);

            handler = new FakeHandler { Answer = r => new HttpResponseMessage(HttpStatusCode.OK) };
            using (var c = new ControlClient(() => null, TokenFile(Token), handler))
            {
                var e = Assert.ThrowsExactly<ControlException>(() => c.Shutdown("stop"));
                StringAssert.Contains(e.Message, "200");
            }
        }

        [TestMethod]
        public void UpdateReturnsTheResultOrTheServersError()
        {
            var handler = new FakeHandler
            {
                Answer = r => JsonResponse(HttpStatusCode.OK, @"{ ""action"": ""staged"", ""message"": ""v0.8.0 installed; restarting to apply it"", ""target"": ""v0.8.0"", ""latest"": ""v0.8.0"", ""pin"": null, ""staged"": { ""tag"": ""v0.8.0"" } }"),
            };
            using (var c = new ControlClient(() => null, TokenFile(Token), handler))
            {
                var r = c.Update("now");
                Assert.AreEqual("staged", r.Action);
                Assert.AreEqual("v0.8.0", r.StagedTag);
                Assert.AreEqual("v0.8.0", r.Target);
            }
            Assert.AreEqual("{\"mode\":\"now\"}", handler.Bodies[0]);

            handler = new FakeHandler { Answer = r => JsonResponse(HttpStatusCode.BadRequest, @"{ ""error"": ""mode must be one of check, scheduled, now"" }") };
            using (var c = new ControlClient(() => null, TokenFile(Token), handler))
            {
                var e = Assert.ThrowsExactly<ControlException>(() => c.Update("later"));
                Assert.AreEqual("mode must be one of check, scheduled, now", e.Message);
            }
        }
    }
}
