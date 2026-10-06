using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Telinha.Tray.Tests
{
    [TestClass]
    public class StringsTests
    {
        private static readonly string[] TableKeys =
        {
            "statusRunning", "statusRooms", "statusStopped", "statusNotAnswering", "statusStarting", "childDetail",
            "stagedDetail", "pinnedDetail", "open", "start", "stop", "restart", "checkUpdates", "updateNow", "updateNowTag",
            "openLog", "autostart", "quit", "checking", "updating", "notifyDown", "notifyStuck", "notifySelfLoop",
            "notifyChildLoop", "notifyAvailable", "notifyApplied", "upToDate", "latestUnknown", "started", "stopped",
            "restarted", "stoppedConsole", "installedRestart", "startFailed", "actionFailed", "noExe",
        };

        [TestMethod]
        public void EveryKeyExistsInBothLanguages()
        {
            CollectionAssert.AreEquivalent(Strings.EnDict.Keys.ToList(), Strings.PtBrDict.Keys.ToList());
            foreach (var key in TableKeys)
            {
                Assert.IsTrue(Strings.EnDict.ContainsKey(key), key);
                Assert.IsTrue(Strings.PtBrDict.ContainsKey(key), key);
            }
        }

        [TestMethod]
        public void BothLanguagesUseTheSamePlaceholders()
        {
            var placeholder = new Regex(@"\{([A-Za-z0-9_]+)\}");
            foreach (var kv in Strings.EnDict)
            {
                var en = placeholder.Matches(kv.Value).Cast<Match>().Select(m => m.Value).OrderBy(x => x).ToList();
                var pt = placeholder.Matches(Strings.PtBrDict[kv.Key]).Cast<Match>().Select(m => m.Value).OrderBy(x => x).ToList();
                CollectionAssert.AreEqual(en, pt, kv.Key);
            }
        }

        [TestMethod]
        public void WordingMatchesTheCli()
        {
            var en = new Strings(Strings.En);
            var pt = new Strings(Strings.PtBr);
            Assert.AreEqual("Service started.", en.T("started"));
            Assert.AreEqual("Serviço parado.", pt.T("stopped"));
            Assert.AreEqual("v0.8.0 installed; the service is restarting to apply it.", en.T("installedRestart", "tag", "v0.8.0"));
            Assert.AreEqual("v0.8.0 instalada; o serviço está reiniciando pra aplicar.", pt.T("installedRestart", "tag", "v0.8.0"));
            Assert.AreEqual("Newest stable release: unknown (offline, or none published)", en.T("latestUnknown"));
            Assert.AreEqual("Já está atualizada.", pt.T("upToDate"));
            Assert.AreEqual("Telinha has not come up in 5 minutes; check the log.", en.T("notifyStuck"));
            Assert.AreEqual("A Telinha não subiu em 5 minutos; veja o log.", pt.T("notifyStuck"));
            Assert.AreEqual("update to v0.8.0 staged", en.T("stagedDetail", "tag", "v0.8.0"));
            Assert.AreEqual("atualização pra v0.8.0 preparada", pt.T("stagedDetail", "tag", "v0.8.0"));
            Assert.AreEqual("pinned to v0.7.0", en.T("pinnedDetail", "pin", "v0.7.0"));
            Assert.AreEqual("fixada em v0.7.0", pt.T("pinnedDetail", "pin", "v0.7.0"));
        }

        [TestMethod]
        public void FillIsOnePassAndLeavesUnknownPlaceholders()
        {
            Assert.AreEqual("Stop failed: {error}", new Strings(Strings.En).T("actionFailed", "action", "Stop"));
            // A value that looks like a placeholder is not filled again.
            Assert.AreEqual("{error} failed: x", new Strings(Strings.En).T("actionFailed", "action", "{error}", "error", "x"));
            Assert.AreEqual("Telinha 0.7.0: running, 2 room(s)", new Strings(Strings.En).T("statusRooms", "version", "0.7.0", "n", 2));
        }

        private static Dictionary<string, string> Env(params string[] pairs)
        {
            var d = new Dictionary<string, string>();
            for (var i = 0; i + 1 < pairs.Length; i += 2) d[pairs[i]] = pairs[i + 1];
            return d;
        }

        [TestMethod]
        public void PickFollowsPickLocale()
        {
            var en = CultureInfo.GetCultureInfo("en-US");
            var ptBr = CultureInfo.GetCultureInfo("pt-BR");
            Assert.AreEqual(Strings.PtBr, Strings.Pick(Env("LOCALE", "pt"), en));
            Assert.AreEqual(Strings.En, Strings.Pick(Env("LOCALE", "en", "LANG", "pt_BR.UTF-8"), ptBr));
            Assert.AreEqual(Strings.PtBr, Strings.Pick(Env("LANG", "pt_BR.UTF-8"), en));
            Assert.AreEqual(Strings.PtBr, Strings.Pick(Env("LC_ALL", "pt_PT", "LANG", "en_US"), en));
            Assert.AreEqual(Strings.En, Strings.Pick(Env("LC_MESSAGES", "en_GB"), ptBr));
            // C and POSIX count as unset: the Windows language decides.
            Assert.AreEqual(Strings.PtBr, Strings.Pick(Env("LANG", "C"), ptBr));
            Assert.AreEqual(Strings.PtBr, Strings.Pick(Env("LANG", "C.UTF-8"), ptBr));
            Assert.AreEqual(Strings.En, Strings.Pick(Env("LC_ALL", "POSIX"), en));
            Assert.AreEqual(Strings.PtBr, Strings.Pick(Env("LOCALE", ""), ptBr));
            Assert.AreEqual(Strings.PtBr, Strings.Pick(Env(), CultureInfo.GetCultureInfo("pt-PT")));
            Assert.AreEqual(Strings.En, Strings.Pick(Env(), CultureInfo.GetCultureInfo("de-DE")));
            Assert.AreEqual(Strings.En, Strings.Pick(Env(), CultureInfo.InvariantCulture));
        }

        [TestMethod]
        public void TooltipFitsNotifyIcon()
        {
            Assert.AreEqual("short", Icons.Tooltip("short"));
            var cut = Icons.Tooltip(new string('x', 100));
            Assert.AreEqual(Icons.MaxTooltip, cut.Length);
            Assert.IsTrue(cut.EndsWith("…"));
        }
    }
}
