using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Telinha.Tray.Tests
{
    /// <summary>The same cases as the server's parseEnvFile tests: both must read a file alike.</summary>
    [TestClass]
    public class EnvFileTests
    {
        private static void Same(IDictionary<string, string> expected, IDictionary<string, string> actual)
        {
            var e = string.Join(";", expected.OrderBy(k => k.Key, StringComparer.Ordinal).Select(k => k.Key + "=" + k.Value));
            var a = string.Join(";", actual.OrderBy(k => k.Key, StringComparer.Ordinal).Select(k => k.Key + "=" + k.Value));
            Assert.AreEqual(e, a);
        }

        [TestMethod]
        public void CommentsBlankLinesExportAndTrimming()
        {
            var vars = EnvFile.Parse(string.Join("\n", new[]
            {
                "# a comment", "", "   ", "  # indented comment",
                "A=1", "  B = two words  ", "export C=3", "export\tD=4", "E=", "F=a=b", "exportG=5",
            }));
            Same(new Dictionary<string, string> { { "A", "1" }, { "B", "two words" }, { "C", "3" }, { "D", "4" }, { "E", "" }, { "F", "a=b" }, { "exportG", "5" } }, vars);
        }

        [TestMethod]
        public void CrlfAndBom()
        {
            Same(new Dictionary<string, string> { { "A", "1" }, { "B", "2" } }, EnvFile.Parse("\uFEFFA=1\r\nB=2\r\n"));
        }

        [TestMethod]
        public void MatchingQuotesStrippedNothingUnescaped()
        {
            var vars = EnvFile.Parse(string.Join("\n", new[]
            {
                "S='it''s'", "D=\"a\\nb\"", "Q=''", "DQ=\"\"", "MIX='abc\"", "ONE='", "HASH=abc #not a comment", "INNER='a \"b\" c'",
            }));
            Same(new Dictionary<string, string>
            {
                { "S", "it''s" }, { "D", "a\\nb" }, { "Q", "" }, { "DQ", "" }, { "MIX", "'abc\"" }, { "ONE", "'" },
                { "HASH", "abc #not a comment" }, { "INNER", "a \"b\" c" },
            }, vars);
        }

        [TestMethod]
        public void BadKeysAndLinesWithoutEqualsAreSkipped()
        {
            Same(new Dictionary<string, string> { { "GOOD", "1" } }, EnvFile.Parse("1A=x\nGOOD=1\nBAD-KEY=x\nsk-live-secret\n=v"));
        }

        [TestMethod]
        public void LaterLinesWin()
        {
            Same(new Dictionary<string, string> { { "A", "2" } }, EnvFile.Parse("A=1\nA=2"));
        }

        [TestMethod]
        public void MissingFileIsEmpty()
        {
            var dir = Path.Combine(Path.GetTempPath(), "telinha-tray-env-" + Guid.NewGuid().ToString("N"));
            Assert.AreEqual(0, EnvFile.Load(Path.Combine(dir, "telinha.env")).Count);
            Directory.CreateDirectory(dir);
            try
            {
                var p = Path.Combine(dir, "telinha.env");
                File.WriteAllText(p, "LISTEN=0.0.0.0:9000\nPUBLIC_URL='https://tv.example.com'\n");
                var vars = EnvFile.Load(p);
                Assert.AreEqual("0.0.0.0:9000", vars["LISTEN"]);
                Assert.AreEqual("https://tv.example.com", vars["PUBLIC_URL"]);
            }
            finally
            {
                Directory.Delete(dir, true);
            }
        }

        [TestMethod]
        public void ProcessEnvironmentWinsUnlessEmpty()
        {
            var file = new Dictionary<string, string> { { "LISTEN", "127.0.0.1:9000" }, { "LOCALE", "pt-BR" }, { "PUBLIC_URL", "https://a" } };
            var process = new Dictionary<string, string> { { "LISTEN", "0.0.0.0:7000" }, { "LOCALE", "" }, { "OTHER", "x" } };
            Same(new Dictionary<string, string>
            {
                { "LISTEN", "0.0.0.0:7000" }, { "LOCALE", "pt-BR" }, { "PUBLIC_URL", "https://a" }, { "OTHER", "x" },
            }, EnvFile.Merge(file, process));
        }

        [TestMethod]
        public void ProcessEnvironmentLookupsIgnoreCase()
        {
            var env = EnvFile.FromProcess(new System.Collections.Hashtable { { "Telinha_Home", @"D:\t" } });
            Assert.AreEqual(@"D:\t", env["TELINHA_HOME"]);
        }
    }
}
