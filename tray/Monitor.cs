using System;
using System.Collections.Generic;
using System.Linq;

namespace Telinha.Tray
{
    public enum Phase
    {
        /// <summary>Before the first poll.</summary>
        Unknown,
        Up,
        /// <summary>No answer, but the service loop lives: Telinha is (re)starting.</summary>
        Starting,
        Down,
    }

    public enum UserActionKind
    {
        Start,
        Stop,
        Restart,
        UpdateNow,
    }

    public enum NotificationKind
    {
        ServiceDown,
        CrashLoop,
        UpdateAvailable,
        UpdateApplied,
    }

    public enum Dot
    {
        Grey,
        Green,
        Amber,
        Red,
    }

    public sealed class Notification
    {
        public NotificationKind Kind;
        public string Text;
    }

    public sealed class MenuState
    {
        public bool Open;
        public bool Start;
        public bool Stop;
        public bool Restart;
        public bool CheckUpdates;
        public bool UpdateNow;
        public string CheckLabel;
        public string UpdateNowLabel;
    }

    public sealed class View
    {
        public Phase Phase;
        public string StatusLine;
        /// <summary>The action result while it stands, else what is worth knowing (children restarting, update state).</summary>
        public List<string> Details = new List<string>();
        public string Tooltip;
        public Dot Dot;
        public MenuState Menu = new MenuState();
        /// <summary>When the next poll is due.</summary>
        public int PollMs;
    }

    /// <summary>Notification de-dup that survives tray restarts (HKCU\Software\Telinha\Tray in the app).</summary>
    public interface INotifiedStore
    {
        string Get(string name);
        void Set(string name, string value);
    }

    /// <summary>
    /// What the tray shows and when it speaks up, from polls of the control endpoint,
    /// the service loop's liveness and the user's own actions. No UI, no clock, no I/O:
    /// every input carries its time.
    /// </summary>
    public sealed class Monitor
    {
        public const int POLL_UP_MS = 10000;
        public const int POLL_DOWN_MS = 15000;
        public const int POLL_AFTER_ACTION_MS = 2000;
        /// <summary>Consecutive failed polls before Down is believed when no service loop runs.</summary>
        public const int DOWN_CONFIRM = 2;
        /// <summary>After a user action Down is never announced: the user caused it.</summary>
        public const long QUIET_MS = 120000;
        /// <summary>How long "starting" may last while the loop lives before it counts as down.</summary>
        public const long START_GRACE_MS = 300000;
        public const int CRASH_LOOP_RESTARTS = 3;
        public const int SELF_RESTARTS = 3;
        /// <summary>The server's recentRestarts window, used for Telinha's own restarts too.</summary>
        public const long RESTART_WINDOW_MS = 600000;
        public const long RESULT_TTL_MS = 30000;

        public const string NotifiedAvailableKey = "NotifiedAvailable";
        public const string NotifiedAppliedKey = "NotifiedApplied";

        private readonly Strings strings;
        private readonly INotifiedStore store;
        private readonly List<Notification> pending = new List<Notification>();
        private readonly HashSet<string> childNotified = new HashSet<string>(StringComparer.Ordinal);
        private readonly List<long> selfRestarts = new List<long>();

        private Phase phase = Phase.Unknown;
        private Status last;
        private bool lastLoopAlive;
        private long? trayStartedMs;
        private long lastStatusMs;
        private long startRef;
        private int misses;
        private bool stuck;
        private bool downNotified;
        private bool selfNotified;
        private long? lastActionMs;
        private bool restartPending;
        private long restartFrom;
        private string result;
        private bool resultFailed;
        private long resultAt;
        private Phase resultPhase;
        private string availableTag;
        private string sessionVersion;

        public Monitor(Strings strings, INotifiedStore store)
        {
            this.strings = strings ?? new Strings(Strings.En);
            this.store = store;
        }

        /// <summary>PUBLIC_URL from the merged env; Open Telinha needs an absolute http(s) URL.</summary>
        public string PublicUrl { get; set; }

        /// <summary>telinha.exe is where the tray looks for it (Start needs it).</summary>
        public bool TelinhaExeExists { get; set; } = true;

        /// <summary>Where the tray runs from, for the "telinha.exe is not next to the tray" line.</summary>
        public string TrayDir { get; set; } = "";

        /// <summary>A start/stop/restart is running: those items wait for it.</summary>
        public bool ActionInFlight { get; set; }

        /// <summary>"check" or "now" while POST /internal/update runs, else null.</summary>
        public string UpdateInFlight { get; set; }

        public Phase Phase
        {
            get { return phase; }
        }

        /// <summary>The last status the service gave (stale outside Up).</summary>
        public Status Last
        {
            get { return last; }
        }

        public void TrayStarted(long nowMs)
        {
            trayStartedMs = nowMs;
        }

        /// <summary>A poll: the status (null when the endpoint did not answer) and whether the service loop lives.</summary>
        public void Observe(Status status, bool loopAlive, long nowMs)
        {
            lastLoopAlive = loopAlive;
            Prune(nowMs);
            if (status != null) ObserveUp(status, nowMs);
            else if (loopAlive) ObserveStarting(nowMs);
            else ObserveMiss(nowMs);
            if (selfRestarts.Count == 0) selfNotified = false;
        }

        /// <summary>
        /// Start, stop, restart or update now, called when the action starts and again when
        /// it returns: each call opens a fresh quiet window.
        /// </summary>
        public void UserAction(UserActionKind kind, long nowMs)
        {
            lastActionMs = nowMs;
        }

        /// <summary>A restart was accepted: "Service restarted." once Telinha answers with a new start time.</summary>
        public void ExpectRestart(long nowMs)
        {
            restartPending = true;
            restartFrom = last == null ? 0 : last.StartedAt;
            lastActionMs = nowMs;
        }

        /// <summary>
        /// An action's outcome for the detail line and tooltip; it never notifies. A failed
        /// one also turns the dot red while it stands.
        /// </summary>
        public void SetResult(string text, long nowMs, bool failed = false)
        {
            result = text;
            resultFailed = failed;
            resultAt = nowMs;
            resultPhase = phase;
        }

        public List<Notification> Drain()
        {
            var list = new List<Notification>(pending);
            pending.Clear();
            return list;
        }

        public bool InQuiet(long nowMs)
        {
            return lastActionMs.HasValue && nowMs - lastActionMs.Value < QUIET_MS;
        }

        private void SetPhase(Phase next)
        {
            if (next == phase) return;
            phase = next;
            // A result describes the state it was given in.
            result = null;
        }

        private void ObserveUp(Status s, long nowMs)
        {
            SetPhase(Phase.Up);
            misses = 0;
            stuck = false;
            // The episode is over: the next Down may be announced again.
            downNotified = false;
            lastStatusMs = nowMs;

            if (last != null && s.StartedAt != 0 && last.StartedAt != 0 && s.StartedAt != last.StartedAt)
            {
                if (!InQuiet(nowMs) && !restartPending) selfRestarts.Add(nowMs);
            }
            if (restartPending && s.StartedAt != restartFrom)
            {
                restartPending = false;
                SetResult(strings.T("restarted"), nowMs);
            }
            else if (restartPending && !InQuiet(nowMs))
            {
                // Still the same start long after the request: it never restarted.
                restartPending = false;
            }
            if (selfRestarts.Count >= SELF_RESTARTS && !selfNotified)
            {
                selfNotified = true;
                Notify(NotificationKind.CrashLoop, strings.T("notifySelfLoop"));
            }

            foreach (var kv in s.ChildStatus)
            {
                if (kv.Value.RecentRestarts >= CRASH_LOOP_RESTARTS)
                {
                    if (childNotified.Add(kv.Key)) Notify(NotificationKind.CrashLoop, strings.T("notifyChildLoop", "name", kv.Key));
                }
                else if (kv.Value.RecentRestarts == 0)
                {
                    childNotified.Remove(kv.Key);
                }
            }

            var u = s.Update;
            availableTag = null;
            // A pinned install installs the pin, never latest: nothing to say about latest then.
            if (u != null && string.IsNullOrEmpty(u.Pin) && !string.IsNullOrEmpty(u.Latest) && SemVer.Compare(u.Latest, s.Version) > 0)
            {
                availableTag = u.Latest;
                if (!SameTag(u.Latest, Stored(NotifiedAvailableKey)))
                {
                    Store(NotifiedAvailableKey, u.Latest);
                    Notify(NotificationKind.UpdateAvailable, strings.T("notifyAvailable", "tag", u.Latest));
                }
            }

            if (u != null && u.HasApplied)
            {
                if (u.Applied != null && !SameTag(u.Applied.Tag, Stored(NotifiedAppliedKey)))
                {
                    Store(NotifiedAppliedKey, u.Applied.Tag);
                    // update.json keeps the record until the next update: one from before this
                    // tray (an install that updated while the tray was off) is old news, only
                    // remembered. The window still covers the hand-over, where the new tray
                    // starts before the service writes "applied".
                    if (u.Applied.At >= (trayStartedMs ?? nowMs) - RESTART_WINDOW_MS)
                    {
                        Notify(NotificationKind.UpdateApplied, strings.T("notifyApplied", "tag", u.Applied.Tag));
                    }
                }
            }
            else if (sessionVersion != null && !string.IsNullOrEmpty(s.Version) && SemVer.Compare(s.Version, sessionVersion) > 0)
            {
                // An older service has no "applied": a newer version seen in this session is one.
                if (!SameTag(s.Version, Stored(NotifiedAppliedKey)))
                {
                    Store(NotifiedAppliedKey, s.Version);
                    Notify(NotificationKind.UpdateApplied, strings.T("notifyApplied", "tag", s.Version));
                }
            }
            if (!string.IsNullOrEmpty(s.Version)) sessionVersion = s.Version;
            last = s;
        }

        private void ObserveStarting(long nowMs)
        {
            misses = 0;
            switch (phase)
            {
                case Phase.Up:
                    startRef = lastStatusMs;
                    SetPhase(Phase.Starting);
                    break;
                case Phase.Unknown:
                    startRef = trayStartedMs ?? nowMs;
                    SetPhase(Phase.Starting);
                    break;
                case Phase.Down:
                    // Stuck stays down until Telinha answers; a loop that came back starts afresh.
                    if (stuck) return;
                    startRef = nowMs;
                    SetPhase(Phase.Starting);
                    break;
            }
            if (phase == Phase.Starting && nowMs - startRef > START_GRACE_MS)
            {
                SetPhase(Phase.Down);
                stuck = true;
                restartPending = false;
                AnnounceDown(nowMs, "notifyStuck");
            }
        }

        private void ObserveMiss(long nowMs)
        {
            misses++;
            switch (phase)
            {
                case Phase.Unknown:
                    // The tray just started next to a stopped service: nothing happened.
                    SetPhase(Phase.Down);
                    break;
                case Phase.Up:
                case Phase.Starting:
                    if (misses < DOWN_CONFIRM) break;
                    SetPhase(Phase.Down);
                    stuck = false;
                    restartPending = false;
                    AnnounceDown(nowMs, "notifyDown");
                    break;
                case Phase.Down:
                    // The loop that was stuck is gone too: plainly stopped now.
                    stuck = false;
                    break;
            }
        }

        private void AnnounceDown(long nowMs, string key)
        {
            if (downNotified || InQuiet(nowMs)) return;
            downNotified = true;
            Notify(NotificationKind.ServiceDown, strings.T(key));
        }

        private void Prune(long nowMs)
        {
            selfRestarts.RemoveAll(t => nowMs - t > RESTART_WINDOW_MS);
        }

        private void Notify(NotificationKind kind, string text)
        {
            pending.Add(new Notification { Kind = kind, Text = text });
        }

        private string Stored(string name)
        {
            try
            {
                return store == null ? null : store.Get(name);
            }
            catch (Exception)
            {
                // An unreadable store only means a repeated balloon.
                return null;
            }
        }

        private void Store(string name, string value)
        {
            try
            {
                if (store != null) store.Set(name, value);
            }
            catch (Exception)
            {
                // Same: the worst case is the balloon again after a tray restart.
            }
        }

        private static string NormTag(string tag)
        {
            return tag != null && tag.StartsWith("v", StringComparison.Ordinal) ? tag.Substring(1) : tag;
        }

        /// <summary>v0.7.0 and 0.7.0 are the same release.</summary>
        public static bool SameTag(string a, string b)
        {
            return a != null && b != null && string.Equals(NormTag(a), NormTag(b), StringComparison.Ordinal);
        }

        /// <summary>Open Telinha only for an absolute http(s) URL.</summary>
        public static bool TryOpenUri(string publicUrl, out Uri uri)
        {
            uri = null;
            Uri u;
            if (string.IsNullOrWhiteSpace(publicUrl) || !Uri.TryCreate(publicUrl.Trim(), UriKind.Absolute, out u)) return false;
            if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return false;
            uri = u;
            return true;
        }

        private bool CrashLoop
        {
            get
            {
                if (selfRestarts.Count >= SELF_RESTARTS) return true;
                return phase == Phase.Up && last != null && last.ChildStatus.Values.Any(c => c.RecentRestarts >= CRASH_LOOP_RESTARTS);
            }
        }

        public View GetView(long nowMs)
        {
            if (result != null && (nowMs - resultAt >= RESULT_TTL_MS || phase != resultPhase)) result = null;
            var v = new View { Phase = phase };
            var confirming = misses > 0 && (phase == Phase.Up || phase == Phase.Starting);

            if (confirming) v.StatusLine = strings.T("statusNotAnswering");
            else if (phase == Phase.Up && last != null)
            {
                v.StatusLine = last.Rooms > 0
                    ? strings.T("statusRooms", "version", last.Version, "n", last.Rooms)
                    : strings.T("statusRunning", "version", last.Version);
            }
            else if (phase == Phase.Starting) v.StatusLine = strings.T("statusStarting");
            // The loop lives but Telinha never answered.
            else if (phase == Phase.Down && stuck) v.StatusLine = strings.T("statusNotAnswering");
            else v.StatusLine = strings.T("statusStopped");

            if (result != null) v.Details.Add(result);
            else
            {
                if (phase == Phase.Up && last != null) v.Details.AddRange(StatusDetails(last));
                if ((phase == Phase.Down || phase == Phase.Unknown) && !TelinhaExeExists) v.Details.Add(strings.T("noExe", "dir", TrayDir));
            }

            v.Tooltip = v.Details.Count > 0 ? v.StatusLine + "\n" + v.Details[0] : v.StatusLine;

            if (CrashLoop || (result != null && resultFailed)) v.Dot = Dot.Red;
            else if (phase == Phase.Up && last != null && last.Update != null && last.Update.FailedTag != null) v.Dot = Dot.Red;
            else if (phase == Phase.Up && availableTag != null) v.Dot = Dot.Amber;
            else if (phase == Phase.Up) v.Dot = Dot.Green;
            else v.Dot = Dot.Grey;

            var up = phase == Phase.Up;
            var hasUpdater = up && last != null && last.Update != null;
            Uri open;
            v.Menu = new MenuState
            {
                Open = TryOpenUri(PublicUrl, out open),
                Start = (phase == Phase.Down || (phase == Phase.Unknown && !lastLoopAlive)) && TelinhaExeExists && !ActionInFlight,
                Stop = up && !ActionInFlight,
                Restart = up && last != null && last.Supervised && !ActionInFlight,
                CheckUpdates = hasUpdater && UpdateInFlight == null,
                UpdateNow = hasUpdater && UpdateInFlight == null,
                CheckLabel = UpdateInFlight == "check" ? strings.T("checking") : strings.T("checkUpdates"),
                UpdateNowLabel = UpdateInFlight == "now"
                    ? strings.T("updating")
                    : availableTag != null ? strings.T("updateNowTag", "tag", availableTag) : strings.T("updateNow"),
            };

            // Right after an action, follow the service closely until it settles.
            if (InQuiet(nowMs) && (phase != Phase.Up || restartPending || misses > 0)) v.PollMs = POLL_AFTER_ACTION_MS;
            else v.PollMs = up ? POLL_UP_MS : POLL_DOWN_MS;
            return v;
        }

        /// <summary>The server's state word in the tray's language; an unknown one as sent.</summary>
        private string ChildState(string state)
        {
            if (string.IsNullOrEmpty(state)) return state ?? "";
            var key = "childState." + state;
            return strings.Has(key) ? strings.T(key) : state;
        }

        private IEnumerable<string> StatusDetails(Status s)
        {
            foreach (var kv in s.ChildStatus.OrderBy(k => k.Key, StringComparer.Ordinal))
            {
                if (kv.Value.RecentRestarts > 0)
                {
                    yield return strings.T("childDetail", "name", kv.Key, "state", ChildState(kv.Value.State), "n", kv.Value.RecentRestarts);
                }
            }
            var u = s.Update;
            if (u == null) yield break;
            if (u.FailedTag != null) yield return strings.T("failedDetail", "tag", u.FailedTag, "reason", u.FailedReason ?? "");
            if (u.StagedTag != null) yield return strings.T("stagedDetail", "tag", u.StagedTag);
            if (u.PendingTag != null) yield return strings.T("pendingDetail", "tag", u.PendingTag);
            if (u.DeferredSince.HasValue) yield return strings.T("deferredDetail");
            if (!string.IsNullOrEmpty(u.Pin)) yield return strings.T("pinnedDetail", "pin", u.Pin);
            else if (availableTag != null) yield return strings.T("notifyAvailable", "tag", availableTag);
        }
    }
}
