using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Telinha.Tray.Tests
{
    [TestClass]
    public class MonitorTests
    {
        private const long T0 = 1700000000000;
        private const long Sec = 1000;
        private const long Min = 60 * Sec;

        private sealed class FakeStore : INotifiedStore
        {
            public readonly Dictionary<string, string> Values = new Dictionary<string, string>();

            public string Get(string name)
            {
                string v;
                return Values.TryGetValue(name, out v) ? v : null;
            }

            public void Set(string name, string value)
            {
                Values[name] = value;
            }
        }

        private static Status Up(string version = "0.7.0", long startedAt = T0 - Min, bool supervised = true, int rooms = 0, UpdateInfo update = null)
        {
            return new Status
            {
                Version = version,
                StartedAt = startedAt,
                Supervised = supervised,
                Rooms = rooms,
                Update = update ?? new UpdateInfo { Current = version, HasApplied = true },
            };
        }

        private static Status WithChildren(Status s, params object[] nameAndRecent)
        {
            for (var i = 0; i + 1 < nameAndRecent.Length; i += 2)
            {
                var n = (int)nameAndRecent[i + 1];
                s.ChildStatus[(string)nameAndRecent[i]] = new ChildStatus { State = n > 0 ? "restarting" : "up", RecentRestarts = n };
            }
            return s;
        }

        private static Monitor New(FakeStore store = null, string locale = Strings.En)
        {
            var m = new Monitor(new Strings(locale), store ?? new FakeStore())
            {
                TelinhaExeExists = true,
                PublicUrl = "https://tv.example.com",
                TrayDir = @"C:\t\bin",
            };
            m.TrayStarted(T0);
            return m;
        }

        private static List<string> Texts(Monitor m, NotificationKind kind)
        {
            return m.Drain().Where(n => n.Kind == kind).Select(n => n.Text).ToList();
        }

        // ------------------------------------------------------------ down / starting

        [TestMethod]
        public void UpToDownNeedsTwoFailedPollsWhenNoLoopRuns()
        {
            var m = New();
            m.Observe(Up(), false, T0);
            Assert.AreEqual(0, m.Drain().Count);

            m.Observe(null, false, T0 + 10 * Sec);
            Assert.AreEqual(Phase.Up, m.Phase);
            Assert.AreEqual("Telinha: not answering", m.GetView(T0 + 10 * Sec).StatusLine);
            Assert.AreEqual(0, m.Drain().Count);

            m.Observe(null, false, T0 + 20 * Sec);
            Assert.AreEqual(Phase.Down, m.Phase);
            CollectionAssert.AreEqual(new[] { "Telinha stopped." }, Texts(m, NotificationKind.ServiceDown));
            Assert.AreEqual("Telinha: not running", m.GetView(T0 + 20 * Sec).StatusLine);

            m.Observe(null, false, T0 + 35 * Sec);
            m.Observe(null, false, T0 + 50 * Sec);
            Assert.AreEqual(0, m.Drain().Count);
        }

        [TestMethod]
        public void AnAnswerBetweenFailuresStartsTheCountAgain()
        {
            var m = New();
            m.Observe(Up(), false, T0);
            m.Observe(null, false, T0 + 10 * Sec);
            m.Observe(Up(), false, T0 + 20 * Sec);
            m.Observe(null, false, T0 + 30 * Sec);
            Assert.AreEqual(Phase.Up, m.Phase);
            Assert.AreEqual(0, m.Drain().Count);
        }

        [TestMethod]
        public void TrayStartingNextToAStoppedServiceSaysNothing()
        {
            var m = New();
            m.Observe(null, false, T0);
            Assert.AreEqual(Phase.Down, m.Phase);
            Assert.AreEqual(0, m.Drain().Count);
            Assert.AreEqual("Telinha: not running", m.GetView(T0).StatusLine);
        }

        [TestMethod]
        public void WhileTheLoopLivesItIsStartingNeverDownBeforeTheGrace()
        {
            var m = New();
            m.Observe(Up(), true, T0);
            for (var t = T0 + 10 * Sec; t <= T0 + Monitor.START_GRACE_MS; t += 15 * Sec)
            {
                m.Observe(null, true, t);
                Assert.AreEqual(Phase.Starting, m.Phase);
            }
            m.Observe(null, true, T0 + Monitor.START_GRACE_MS);
            Assert.AreEqual(Phase.Starting, m.Phase);
            var view = m.GetView(T0 + Monitor.START_GRACE_MS);
            Assert.AreEqual("Telinha: starting\u2026", view.StatusLine);
            Assert.AreEqual(Dot.Grey, view.Dot);
            Assert.AreEqual(0, m.Drain().Count);

            m.Observe(null, true, T0 + Monitor.START_GRACE_MS + 1);
            Assert.AreEqual(Phase.Down, m.Phase);
            CollectionAssert.AreEqual(new[] { "Telinha has not come up in 5 minutes; check the log." }, Texts(m, NotificationKind.ServiceDown));
            Assert.AreEqual("Telinha: not answering", m.GetView(T0 + Monitor.START_GRACE_MS + 1).StatusLine);

            // Stuck stays down, and says so once.
            m.Observe(null, true, T0 + Monitor.START_GRACE_MS + Min);
            Assert.AreEqual(Phase.Down, m.Phase);
            Assert.AreEqual(0, m.Drain().Count);
        }

        [TestMethod]
        public void StartingRightAfterTheTrayStartsCountsFromTrayStart()
        {
            var m = New();
            m.Observe(null, true, T0 + Sec);
            Assert.AreEqual(Phase.Starting, m.Phase);
            m.Observe(null, true, T0 + Monitor.START_GRACE_MS);
            Assert.AreEqual(Phase.Starting, m.Phase);
            m.Observe(null, true, T0 + Monitor.START_GRACE_MS + Sec);
            Assert.AreEqual(Phase.Down, m.Phase);
            Assert.AreEqual(1, Texts(m, NotificationKind.ServiceDown).Count);
        }

        [TestMethod]
        public void ALoopThatComesBackAfterDownGetsAFreshGrace()
        {
            var m = New();
            m.Observe(null, false, T0);
            m.Observe(null, true, T0 + 10 * Min);
            Assert.AreEqual(Phase.Starting, m.Phase);
            m.Observe(null, true, T0 + 14 * Min);
            Assert.AreEqual(Phase.Starting, m.Phase);
            Assert.AreEqual(0, m.Drain().Count);
        }

        [TestMethod]
        public void OneNotificationPerEpisode()
        {
            var m = New();
            m.Observe(Up(), false, T0);
            m.Observe(null, false, T0 + 10 * Sec);
            m.Observe(null, false, T0 + 20 * Sec);
            Assert.AreEqual(1, Texts(m, NotificationKind.ServiceDown).Count);
            m.Observe(null, false, T0 + 40 * Sec);
            Assert.AreEqual(0, m.Drain().Count);

            // Back up: the next Down is a new episode.
            m.Observe(Up(), false, T0 + Min);
            m.Observe(null, false, T0 + Min + 10 * Sec);
            m.Observe(null, false, T0 + Min + 20 * Sec);
            Assert.AreEqual(1, Texts(m, NotificationKind.ServiceDown).Count);
        }

        // ------------------------------------------------------------ quiet window

        [TestMethod]
        public void QuietWindowSilencesDownAfterStop()
        {
            var m = New();
            m.Observe(Up(), false, T0);
            m.UserAction(UserActionKind.Stop, T0 + Sec);
            m.UserAction(UserActionKind.Stop, T0 + 3 * Sec);
            m.Observe(null, false, T0 + 5 * Sec);
            m.Observe(null, false, T0 + 7 * Sec);
            Assert.AreEqual(Phase.Down, m.Phase);
            Assert.AreEqual(0, m.Drain().Count);
        }

        [TestMethod]
        public void QuietWindowEndsAfterQuietMs()
        {
            var m = New();
            m.Observe(Up(), false, T0);
            m.UserAction(UserActionKind.Restart, T0);
            m.Observe(null, false, T0 + Monitor.QUIET_MS);
            m.Observe(null, false, T0 + Monitor.QUIET_MS + 10 * Sec);
            Assert.AreEqual(1, Texts(m, NotificationKind.ServiceDown).Count);
        }

        [TestMethod]
        public void TheReturnCallReArmsTheQuietWindow()
        {
            // Update now: the call takes minutes (download and stage), then the service restarts.
            Func<bool, int> run = reArm =>
            {
                var m = New();
                m.Observe(Up(), false, T0);
                m.UserAction(UserActionKind.UpdateNow, T0);
                if (reArm) m.UserAction(UserActionKind.UpdateNow, T0 + 5 * Min);
                m.Observe(null, false, T0 + 5 * Min + 10 * Sec);
                m.Observe(null, false, T0 + 5 * Min + 20 * Sec);
                Assert.AreEqual(Phase.Down, m.Phase);
                return Texts(m, NotificationKind.ServiceDown).Count;
            };
            Assert.AreEqual(1, run(false));
            Assert.AreEqual(0, run(true));
        }

        [TestMethod]
        public void RestartIsStartingThenRestartedWithoutAnyNotification()
        {
            var m = New();
            m.Observe(Up(startedAt: 100), true, T0);
            m.UserAction(UserActionKind.Restart, T0);
            m.ExpectRestart(T0 + 100);
            m.UserAction(UserActionKind.Restart, T0 + 100);
            Assert.AreEqual(Monitor.POLL_AFTER_ACTION_MS, m.GetView(T0 + 100).PollMs);
            m.Observe(null, true, T0 + 2 * Sec);
            Assert.AreEqual(Phase.Starting, m.Phase);
            m.Observe(Up(startedAt: T0 + 3 * Sec), true, T0 + 4 * Sec);
            Assert.AreEqual(Phase.Up, m.Phase);
            var view = m.GetView(T0 + 4 * Sec);
            CollectionAssert.AreEqual(new[] { "Service restarted." }, view.Details);
            Assert.AreEqual(0, m.Drain().Count);
        }

        // ------------------------------------------------------------ crash loops

        [TestMethod]
        public void CrashLoopPerChildOncePerEpisode()
        {
            var m = New();
            var t = T0;
            Func<object[], List<string>> poll = children =>
            {
                t += 10 * Sec;
                m.Observe(WithChildren(Up(), children), true, t);
                return Texts(m, NotificationKind.CrashLoop);
            };
            Assert.AreEqual(0, poll(new object[] { "livekit", 1, "caddy", 0 }).Count);
            Assert.AreEqual(0, poll(new object[] { "livekit", 2, "caddy", 0 }).Count);
            CollectionAssert.AreEqual(new[] { "livekit keeps crashing; check the log." }, poll(new object[] { "livekit", 3, "caddy", 0 }));
            Assert.AreEqual(Dot.Red, m.GetView(t).Dot);
            Assert.AreEqual(0, poll(new object[] { "livekit", 4, "caddy", 0 }).Count);
            CollectionAssert.AreEqual(new[] { "caddy keeps crashing; check the log." }, poll(new object[] { "livekit", 4, "caddy", 3 }));
            // Still restarting now and then: the same episode.
            Assert.AreEqual(0, poll(new object[] { "livekit", 1, "caddy", 3 }).Count);
            Assert.AreEqual(0, poll(new object[] { "livekit", 3, "caddy", 3 }).Count);
            // The window emptied: the episode is over.
            Assert.AreEqual(0, poll(new object[] { "livekit", 0, "caddy", 0 }).Count);
            Assert.AreEqual(Dot.Green, m.GetView(t).Dot);
            CollectionAssert.AreEqual(new[] { "livekit keeps crashing; check the log." }, poll(new object[] { "livekit", 3, "caddy", 0 }));
        }

        [TestMethod]
        public void ChildDetailLine()
        {
            var m = New();
            m.Observe(WithChildren(Up(), "livekit", 2, "caddy", 0), true, T0);
            CollectionAssert.AreEqual(new[] { "livekit: restarting (2 restarts in 10 min)" }, m.GetView(T0).Details);
        }

        [TestMethod]
        public void ChildDetailLineInPortugueseTranslatesTheState()
        {
            var m = New(locale: Strings.PtBr);
            var s = WithChildren(Up(), "livekit", 2, "caddy", 1);
            s.ChildStatus["caddy"].State = "starting";
            m.Observe(s, true, T0);
            CollectionAssert.AreEqual(new[] { "caddy: iniciando (1 reinícios em 10 min)", "livekit: reiniciando (2 reinícios em 10 min)" }, m.GetView(T0).Details);
            // A state this tray does not know is shown as the server sent it.
            s.ChildStatus["caddy"].State = "draining";
            m.Observe(s, true, T0 + 10 * Sec);
            Assert.AreEqual("caddy: draining (1 reinícios em 10 min)", m.GetView(T0 + 10 * Sec).Details[0]);
        }

        [TestMethod]
        public void AFailedActionShowsInTheDetailLineWithARedDotAndNeverNotifies()
        {
            var m = New();
            m.Observe(null, false, T0);
            m.UserAction(UserActionKind.Start, T0 + Sec);
            m.SetResult("Could not start Telinha: access denied", T0 + 2 * Sec, true);
            var v = m.GetView(T0 + 2 * Sec);
            CollectionAssert.AreEqual(new[] { "Could not start Telinha: access denied" }, v.Details);
            Assert.AreEqual("Telinha: not running\nCould not start Telinha: access denied", v.Tooltip);
            Assert.AreEqual(Dot.Red, v.Dot);
            Assert.AreEqual(0, m.Drain().Count);
            // It stands like any result, then the dot goes back.
            Assert.AreEqual(Dot.Grey, m.GetView(T0 + 2 * Sec + Monitor.RESULT_TTL_MS).Dot);
            m.SetResult("Up to date.", T0 + Min);
            Assert.AreEqual(Dot.Grey, m.GetView(T0 + Min).Dot);
        }

        [TestMethod]
        public void TelinhaRestartingItselfCountsStartedAtChanges()
        {
            var m = New();
            m.Observe(Up(startedAt: 1), true, T0);
            m.Observe(Up(startedAt: 2), true, T0 + Min);
            m.Observe(Up(startedAt: 3), true, T0 + 2 * Min);
            Assert.AreEqual(0, m.Drain().Count);
            m.Observe(Up(startedAt: 4), true, T0 + 3 * Min);
            CollectionAssert.AreEqual(new[] { "Telinha keeps restarting; check the log." }, Texts(m, NotificationKind.CrashLoop));
            Assert.AreEqual(Dot.Red, m.GetView(T0 + 3 * Min).Dot);
            m.Observe(Up(startedAt: 5), true, T0 + 4 * Min);
            Assert.AreEqual(0, m.Drain().Count);

            // Ten quiet minutes later the window is empty: a new episode may be announced.
            m.Observe(Up(startedAt: 5), true, T0 + 15 * Min);
            Assert.AreEqual(Dot.Green, m.GetView(T0 + 15 * Min).Dot);
            m.Observe(Up(startedAt: 6), true, T0 + 16 * Min);
            m.Observe(Up(startedAt: 7), true, T0 + 17 * Min);
            m.Observe(Up(startedAt: 8), true, T0 + 18 * Min);
            Assert.AreEqual(1, Texts(m, NotificationKind.CrashLoop).Count);
        }

        [TestMethod]
        public void RestartsOlderThanTheWindowDoNotAddUp()
        {
            var m = New();
            m.Observe(Up(startedAt: 1), true, T0);
            m.Observe(Up(startedAt: 2), true, T0 + 1 * Min);
            m.Observe(Up(startedAt: 3), true, T0 + 6 * Min);
            m.Observe(Up(startedAt: 4), true, T0 + 12 * Min);
            Assert.AreEqual(0, m.Drain().Count);
        }

        [TestMethod]
        public void RestartsTheUserAskedForAreNotACrashLoop()
        {
            var m = New();
            m.Observe(Up(startedAt: 1), true, T0);
            for (var i = 2; i <= 5; i++)
            {
                var t = T0 + i * Min;
                m.UserAction(UserActionKind.Restart, t);
                m.Observe(Up(startedAt: i), true, t + 10 * Sec);
            }
            Assert.AreEqual(0, m.Drain().Count);
        }

        // ------------------------------------------------------------ updates

        [TestMethod]
        public void UpdateAvailableOncePerTagAndPersisted()
        {
            var store = new FakeStore();
            var m = New(store);
            var u = new UpdateInfo { Latest = "v0.8.0", HasApplied = true };
            m.Observe(Up(update: u), true, T0);
            CollectionAssert.AreEqual(new[] { "v0.8.0 is available." }, Texts(m, NotificationKind.UpdateAvailable));
            Assert.AreEqual("v0.8.0", store.Get(Monitor.NotifiedAvailableKey));
            var view = m.GetView(T0);
            Assert.AreEqual(Dot.Amber, view.Dot);
            Assert.AreEqual("Update now (v0.8.0)", view.Menu.UpdateNowLabel);
            CollectionAssert.Contains(view.Details, "v0.8.0 is available.");

            m.Observe(Up(update: u), true, T0 + 10 * Sec);
            Assert.AreEqual(0, m.Drain().Count);

            // A restarted tray reads what it already said.
            var again = New(store);
            again.Observe(Up(update: u), true, T0 + Min);
            Assert.AreEqual(0, again.Drain().Count);

            again.Observe(Up(update: new UpdateInfo { Latest = "v0.9.0", HasApplied = true }), true, T0 + 2 * Min);
            CollectionAssert.AreEqual(new[] { "v0.9.0 is available." }, Texts(again, NotificationKind.UpdateAvailable));
        }

        [TestMethod]
        public void NothingAboutLatestWhilePinned()
        {
            var store = new FakeStore();
            var m = New(store);
            m.Observe(Up(update: new UpdateInfo { Latest = "v0.8.0", Pin = "v0.7.0", HasApplied = true }), true, T0);
            Assert.AreEqual(0, m.Drain().Count);
            Assert.IsNull(store.Get(Monitor.NotifiedAvailableKey));
            var view = m.GetView(T0);
            Assert.AreEqual(Dot.Green, view.Dot);
            Assert.AreEqual("Update now", view.Menu.UpdateNowLabel);
            CollectionAssert.AreEqual(new[] { "pinned to v0.7.0" }, view.Details);
        }

        [TestMethod]
        public void LatestNotNewerIsNotAvailable()
        {
            var m = New();
            m.Observe(Up(update: new UpdateInfo { Latest = "v0.7.0", HasApplied = true }), true, T0);
            m.Observe(Up(update: new UpdateInfo { Latest = "v0.6.0", HasApplied = true }), true, T0 + 10 * Sec);
            Assert.AreEqual(0, m.Drain().Count);
            // A prerelease build sees its release as newer.
            m.Observe(Up("0.8.0-rc.1", update: new UpdateInfo { Latest = "v0.8.0", HasApplied = true }), true, T0 + 20 * Sec);
            Assert.AreEqual(1, Texts(m, NotificationKind.UpdateAvailable).Count);
        }

        [TestMethod]
        public void UpdateAppliedFromTheField()
        {
            var store = new FakeStore();
            var m = New(store);
            var applied = new UpdateInfo { HasApplied = true, Applied = new UpdateApplied { Tag = "v0.8.0", Previous = "0.7.0", At = T0 } };
            m.Observe(Up("0.8.0", update: applied), true, T0);
            CollectionAssert.AreEqual(new[] { "Updated to v0.8.0." }, Texts(m, NotificationKind.UpdateApplied));
            Assert.AreEqual("v0.8.0", store.Get(Monitor.NotifiedAppliedKey));
            m.Observe(Up("0.8.0", update: applied), true, T0 + 10 * Sec);
            Assert.AreEqual(0, m.Drain().Count);
            // Whichever tray instance saw it first said it.
            var relaunched = New(store);
            relaunched.Observe(Up("0.8.0", update: applied), true, T0 + Min);
            Assert.AreEqual(0, relaunched.Drain().Count);
        }

        [TestMethod]
        public void AnOldAppliedRecordOnAFirstStartIsRememberedNotAnnounced()
        {
            // The install updated weeks ago, while it had no tray; this is the tray's first run.
            var store = new FakeStore();
            var m = New(store);
            var old = new UpdateInfo { HasApplied = true, Applied = new UpdateApplied { Tag = "v0.8.0", Previous = "0.7.0", At = T0 - 20 * 24 * 60 * Min } };
            m.Observe(Up("0.8.0", update: old), true, T0);
            Assert.AreEqual(0, m.Drain().Count);
            Assert.AreEqual("v0.8.0", store.Get(Monitor.NotifiedAppliedKey));

            // The next update, applied while this tray runs, is news.
            var next = new UpdateInfo { HasApplied = true, Applied = new UpdateApplied { Tag = "v0.9.0", Previous = "0.8.0", At = T0 + 30 * Min } };
            m.Observe(Up("0.9.0", update: next), true, T0 + 30 * Min);
            CollectionAssert.AreEqual(new[] { "Updated to v0.9.0." }, Texts(m, NotificationKind.UpdateApplied));
        }

        [TestMethod]
        public void AnAppliedRecordWrittenJustBeforeTheHandOverIsAnnounced()
        {
            // The relaunched tray started a little after the service wrote "applied".
            var m = New();
            var applied = new UpdateInfo { HasApplied = true, Applied = new UpdateApplied { Tag = "v0.8.0", Previous = "0.7.0", At = T0 - 2 * Min } };
            m.Observe(Up("0.8.0", update: applied), true, T0);
            CollectionAssert.AreEqual(new[] { "Updated to v0.8.0." }, Texts(m, NotificationKind.UpdateApplied));
        }

        [TestMethod]
        public void UpdateAppliedFromAVersionChangeOnAnOlderServer()
        {
            var store = new FakeStore();
            var m = New(store);
            var old = new UpdateInfo { HasApplied = false };
            m.Observe(Up("0.7.0", startedAt: 1, update: old), true, T0);
            Assert.AreEqual(0, m.Drain().Count);
            m.Observe(Up("0.8.0", startedAt: 2, update: old), true, T0 + Min);
            CollectionAssert.AreEqual(new[] { "Updated to 0.8.0." }, Texts(m, NotificationKind.UpdateApplied));
            // A rollback is no update.
            m.Observe(Up("0.7.0", startedAt: 3, update: old), true, T0 + 2 * Min);
            Assert.AreEqual(0, Texts(m, NotificationKind.UpdateApplied).Count);
        }

        [TestMethod]
        public void ANewerServerWithoutAppliedSaysNothingOnAVersionChange()
        {
            var m = New();
            m.Observe(Up("0.7.0", startedAt: 1, update: new UpdateInfo { HasApplied = true }), true, T0);
            m.Observe(Up("0.8.0", startedAt: 2, update: new UpdateInfo { HasApplied = true }), true, T0 + Min);
            Assert.AreEqual(0, Texts(m, NotificationKind.UpdateApplied).Count);
        }

        [TestMethod]
        public void UpdateStateOnlyChangesTheDetailLine()
        {
            var m = New();
            m.Observe(Up(update: new UpdateInfo { HasApplied = true, StagedTag = "v0.8.0" }), true, T0);
            Assert.AreEqual(0, m.Drain().Count);
            CollectionAssert.AreEqual(new[] { "update to v0.8.0 staged" }, m.GetView(T0).Details);
            m.Observe(Up(update: new UpdateInfo { HasApplied = true, FailedTag = "v0.8.0", FailedReason = "bad checksum" }), true, T0 + 10 * Sec);
            Assert.AreEqual(0, m.Drain().Count);
            var view = m.GetView(T0 + 10 * Sec);
            CollectionAssert.AreEqual(new[] { "update to v0.8.0 failed: bad checksum" }, view.Details);
            Assert.AreEqual(Dot.Red, view.Dot);
        }

        // ------------------------------------------------------------ results

        [TestMethod]
        public void ActionResultsExpire()
        {
            var m = New();
            m.Observe(Up(rooms: 2), true, T0);
            m.SetResult("Up to date.", T0 + Sec);
            var view = m.GetView(T0 + Sec);
            CollectionAssert.AreEqual(new[] { "Up to date." }, view.Details);
            Assert.AreEqual("Telinha 0.7.0: running, 2 room(s)\nUp to date.", view.Tooltip);
            Assert.AreEqual(0, m.Drain().Count);
            CollectionAssert.AreEqual(new[] { "Up to date." }, m.GetView(T0 + Sec + Monitor.RESULT_TTL_MS - 1).Details);
            Assert.AreEqual(0, m.GetView(T0 + Sec + Monitor.RESULT_TTL_MS).Details.Count);
        }

        [TestMethod]
        public void ActionResultsGoWithAPhaseChange()
        {
            var m = New();
            m.Observe(null, false, T0);
            m.SetResult("Service started.", T0 + Sec);
            CollectionAssert.AreEqual(new[] { "Service started." }, m.GetView(T0 + Sec).Details);
            m.Observe(null, true, T0 + 3 * Sec);
            Assert.AreEqual(Phase.Starting, m.Phase);
            Assert.AreEqual(0, m.GetView(T0 + 3 * Sec).Details.Count);
        }

        // ------------------------------------------------------------ view

        [TestMethod]
        public void StatusLinesAndDots()
        {
            var m = New();
            m.Observe(Up(rooms: 0), true, T0);
            var v = m.GetView(T0);
            Assert.AreEqual("Telinha 0.7.0: running", v.StatusLine);
            Assert.AreEqual(Dot.Green, v.Dot);
            Assert.AreEqual("Telinha 0.7.0: running", v.Tooltip);
            m.Observe(Up(rooms: 3), true, T0 + 10 * Sec);
            Assert.AreEqual("Telinha 0.7.0: running, 3 room(s)", m.GetView(T0 + 10 * Sec).StatusLine);

            var pt = New(locale: Strings.PtBr);
            pt.Observe(Up(rooms: 3), true, T0);
            Assert.AreEqual("Telinha 0.7.0: rodando, 3 sala(s)", pt.GetView(T0).StatusLine);
            pt.Observe(null, false, T0 + 10 * Sec);
            pt.Observe(null, false, T0 + 20 * Sec);
            Assert.AreEqual("A Telinha parou.", pt.Drain().Single().Text);
            Assert.AreEqual("Telinha: parada", pt.GetView(T0 + 20 * Sec).StatusLine);
        }

        [TestMethod]
        public void PollCadence()
        {
            var m = New();
            m.Observe(Up(), false, T0);
            Assert.AreEqual(Monitor.POLL_UP_MS, m.GetView(T0).PollMs);
            m.Observe(null, false, T0 + 10 * Sec);
            m.Observe(null, false, T0 + 20 * Sec);
            Assert.AreEqual(Monitor.POLL_DOWN_MS, m.GetView(T0 + 20 * Sec).PollMs);
            m.UserAction(UserActionKind.Start, T0 + 30 * Sec);
            Assert.AreEqual(Monitor.POLL_AFTER_ACTION_MS, m.GetView(T0 + 31 * Sec).PollMs);
            Assert.AreEqual(Monitor.POLL_DOWN_MS, m.GetView(T0 + 30 * Sec + Monitor.QUIET_MS).PollMs);
        }

        [TestMethod]
        public void MenuMatrix()
        {
            // Before the first poll, no loop: Start.
            var m = New();
            var menu = m.GetView(T0).Menu;
            Assert.IsTrue(menu.Start);
            Assert.IsFalse(menu.Stop || menu.Restart || menu.CheckUpdates || menu.UpdateNow);

            // Up and supervised: everything but Start.
            m.Observe(Up(supervised: true), true, T0);
            menu = m.GetView(T0).Menu;
            Assert.IsFalse(menu.Start);
            Assert.IsTrue(menu.Stop && menu.Restart && menu.CheckUpdates && menu.UpdateNow && menu.Open);
            Assert.AreEqual("Check for updates", menu.CheckLabel);
            Assert.AreEqual("Update now", menu.UpdateNowLabel);

            // A console run: no Restart (no loop would start it again).
            m.Observe(Up(supervised: false), false, T0 + 10 * Sec);
            menu = m.GetView(T0 + 10 * Sec).Menu;
            Assert.IsTrue(menu.Stop);
            Assert.IsFalse(menu.Restart);

            // No updater in the service: no update items.
            var noUpdater = Up();
            noUpdater.Update = null;
            m.Observe(noUpdater, true, T0 + 20 * Sec);
            menu = m.GetView(T0 + 20 * Sec).Menu;
            Assert.IsFalse(menu.CheckUpdates || menu.UpdateNow);

            // An update call in flight disables both and says what runs.
            m.Observe(Up(), true, T0 + 30 * Sec);
            m.UpdateInFlight = "check";
            menu = m.GetView(T0 + 30 * Sec).Menu;
            Assert.IsFalse(menu.CheckUpdates || menu.UpdateNow);
            Assert.AreEqual("Checking\u2026", menu.CheckLabel);
            m.UpdateInFlight = "now";
            Assert.AreEqual("Updating\u2026", m.GetView(T0 + 30 * Sec).Menu.UpdateNowLabel);
            m.UpdateInFlight = null;

            // A start/stop/restart in flight holds the others.
            m.ActionInFlight = true;
            menu = m.GetView(T0 + 30 * Sec).Menu;
            Assert.IsFalse(menu.Start || menu.Stop || menu.Restart);
            m.ActionInFlight = false;

            // Starting: nothing to start, stop or restart yet.
            m.Observe(null, true, T0 + 40 * Sec);
            menu = m.GetView(T0 + 40 * Sec).Menu;
            Assert.IsFalse(menu.Start || menu.Stop || menu.Restart || menu.CheckUpdates || menu.UpdateNow);

            // Down: Start, as long as telinha.exe is there.
            m.Observe(null, false, T0 + 50 * Sec);
            m.Observe(null, false, T0 + 60 * Sec);
            Assert.AreEqual(Phase.Down, m.Phase);
            Assert.IsTrue(m.GetView(T0 + 60 * Sec).Menu.Start);
            m.TelinhaExeExists = false;
            var view = m.GetView(T0 + 60 * Sec);
            Assert.IsFalse(view.Menu.Start);
            CollectionAssert.AreEqual(new[] { @"telinha.exe is not next to the tray (C:\t\bin)." }, view.Details);

            // Unknown with the loop alive is not a Down: no Start.
            var fresh = New();
            fresh.Observe(null, true, T0);
            Assert.IsFalse(fresh.GetView(T0).Menu.Start);
        }

        [TestMethod]
        public void OpenNeedsAnAbsoluteHttpUrl()
        {
            var m = New();
            foreach (var good in new[] { "https://tv.example.com", "http://localhost:8080", " https://tv.example.com/ " })
            {
                m.PublicUrl = good;
                Assert.IsTrue(m.GetView(T0).Menu.Open, good);
            }
            foreach (var bad in new[] { null, "", "tv.example.com", "/relative", "ftp://tv.example.com", "file:///C:/Windows/notepad.exe", "javascript:alert(1)", "C:\\Windows\\notepad.exe", "\\\\server\\share" })
            {
                m.PublicUrl = bad;
                Assert.IsFalse(m.GetView(T0).Menu.Open, bad ?? "null");
            }
        }
    }
}
