using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace Telinha.Tray
{
    public sealed class TrayOptions
    {
        public Home Home;
        public string Version;
        public string Exe;
        public int Pid;
        public Strings Strings;
        public IDictionary<string, string> ProcessEnv;
        public Action ReleaseMutex;
    }

    /// <summary>
    /// The icon next to the clock: a NotifyIcon with its menu, a poll timer and the
    /// hidden window that lets taskkill, logoff and `telinha tray stop` close it cleanly.
    /// </summary>
    public sealed class TrayApp : ApplicationContext
    {
        private const int DetailSlots = 4;
        private const int BalloonMs = 8000;

        private static NotifyIcon current;

        private readonly TrayOptions o;
        private readonly Strings s;
        private readonly HiddenForm form;
        private readonly NotifyIcon icon;
        private readonly ContextMenuStrip menu;
        private readonly ToolStripMenuItem statusItem;
        private readonly ToolStripMenuItem[] detailItems = new ToolStripMenuItem[DetailSlots];
        private readonly ToolStripMenuItem openItem;
        private readonly ToolStripMenuItem startItem;
        private readonly ToolStripMenuItem stopItem;
        private readonly ToolStripMenuItem restartItem;
        private readonly ToolStripMenuItem checkItem;
        private readonly ToolStripMenuItem updateItem;
        private readonly ToolStripMenuItem logItem;
        private readonly ToolStripMenuItem autostartItem;
        private readonly ToolStripMenuItem quitItem;
        private readonly System.Windows.Forms.Timer timer;
        private readonly Monitor monitor;
        private readonly ControlClient client;
        private readonly Actions actions;
        private readonly Autostart autostart;
        private readonly Relaunch.Watch ownFile;

        private volatile string listen;
        private DateTime envStamp = DateTime.MinValue;
        private bool polling;
        private int? pollSoonMs;
        private bool shutDown;
        private bool rendering;
        private IntPtr iconHandle = IntPtr.Zero;
        private Icon iconObject;
        private Dot? iconDot;
        private int iconSize;

        public TrayApp(TrayOptions options)
        {
            o = options;
            s = options.Strings;

            // taskkill (without /F), `telinha tray stop` and logoff only reach windows.
            form = new HiddenForm(Shutdown);
            form.Show();

            monitor = new Monitor(s, new RegistryNotifiedStore()) { TrayDir = o.Home.TrayDir };
            client = new ControlClient(() => listen, o.Home.TokenFile);
            actions = new Actions(o.Home, s, client);
            autostart = new Autostart(new HkcuValue(Autostart.RunKey, Autostart.ValueName), o.Exe);
            ownFile = new Relaunch.Watch(o.Exe);
            ReloadEnv();

            menu = new ContextMenuStrip();
            statusItem = new ToolStripMenuItem { Enabled = false };
            menu.Items.Add(statusItem);
            for (var i = 0; i < DetailSlots; i++)
            {
                detailItems[i] = new ToolStripMenuItem { Enabled = false, Visible = false };
                menu.Items.Add(detailItems[i]);
            }
            menu.Items.Add(new ToolStripSeparator());
            openItem = Item(s.T("open"), (a, b) => OpenTelinha());
            menu.Items.Add(openItem);
            menu.Items.Add(new ToolStripSeparator());
            startItem = Item(s.T("start"), (a, b) => DoStart());
            stopItem = Item(s.T("stop"), (a, b) => DoStop());
            restartItem = Item(s.T("restart"), (a, b) => DoRestart());
            menu.Items.AddRange(new ToolStripItem[] { startItem, stopItem, restartItem });
            menu.Items.Add(new ToolStripSeparator());
            checkItem = Item(s.T("checkUpdates"), (a, b) => DoUpdate("check"));
            updateItem = Item(s.T("updateNow"), (a, b) => DoUpdate("now"));
            menu.Items.AddRange(new ToolStripItem[] { checkItem, updateItem });
            menu.Items.Add(new ToolStripSeparator());
            logItem = Item(s.T("openLog"), (a, b) => OpenLog());
            menu.Items.Add(logItem);
            autostartItem = new ToolStripMenuItem(s.T("autostart")) { CheckOnClick = true };
            autostartItem.CheckedChanged += (a, b) => ToggleAutostart();
            menu.Items.Add(autostartItem);
            menu.Items.Add(new ToolStripSeparator());
            quitItem = Item(s.T("quit"), (a, b) => Shutdown());
            menu.Items.Add(quitItem);
            menu.Opening += (a, b) => Render();

            icon = new NotifyIcon { ContextMenuStrip = menu, Text = "Telinha" };
            icon.MouseDoubleClick += (a, e) =>
            {
                if (e.Button == MouseButtons.Left && !OpenTelinha()) ShowMenu();
            };
            current = icon;
            SetIcon(Dot.Grey);
            icon.Visible = true;

            timer = new System.Windows.Forms.Timer();
            timer.Tick += (a, b) =>
            {
                timer.Stop();
                Poll();
            };

            monitor.TrayStarted(Program.NowMs());
            Render();
            SchedulePoll(1);
        }

        /// <summary>After a crash: the icon must not linger next to the clock.</summary>
        public static void EmergencyHide()
        {
            try
            {
                var i = current;
                if (i != null) i.Visible = false;
            }
            catch (Exception)
            {
                // the process is going away anyway
            }
        }

        private static ToolStripMenuItem Item(string text, EventHandler onClick)
        {
            var item = new ToolStripMenuItem(text);
            item.Click += onClick;
            return item;
        }

        private static long Now()
        {
            return Program.NowMs();
        }

        // ------------------------------------------------------------ polling

        /// <summary>telinha.env again when it changed: LISTEN, PUBLIC_URL.</summary>
        private void ReloadEnv()
        {
            DateTime stamp;
            try
            {
                stamp = File.Exists(o.Home.EnvFile) ? File.GetLastWriteTimeUtc(o.Home.EnvFile) : DateTime.MinValue;
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is ArgumentException || e is NotSupportedException)
            {
                stamp = DateTime.MinValue;
            }
            if (stamp == envStamp && listen != null) return;
            envStamp = stamp;
            var merged = EnvFile.Merge(EnvFile.Load(o.Home.EnvFile), o.ProcessEnv);
            string v;
            listen = merged.TryGetValue("LISTEN", out v) ? v : "";
            monitor.PublicUrl = merged.TryGetValue("PUBLIC_URL", out v) ? v : null;
        }

        private void SchedulePoll(int ms)
        {
            if (shutDown) return;
            if (polling)
            {
                pollSoonMs = pollSoonMs.HasValue ? Math.Min(pollSoonMs.Value, ms) : ms;
                return;
            }
            timer.Stop();
            timer.Interval = Math.Max(1, ms);
            timer.Start();
        }

        private void Poll()
        {
            if (polling || shutDown) return;
            polling = true;
            ReloadEnv();
            monitor.TelinhaExeExists = File.Exists(o.Home.TelinhaExe);
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Status status = null;
                var loopAlive = false;
                string fileVersion = null;
                try
                {
                    status = client.Status();
                    loopAlive = ServicePid.LoopAlive(o.Home.ServicePid);
                    fileVersion = ownFile.ChangedVersion();
                }
                catch (Exception e)
                {
                    // A poll that breaks counts as no answer; the next one tries again.
                    Program.Log("telinha-tray: poll failed: " + e.Message);
                }
                finally
                {
                    Post(() => Polled(status, loopAlive, fileVersion));
                }
            });
        }

        private void Polled(Status status, bool loopAlive, string fileVersion)
        {
            polling = false;
            if (shutDown) return;
            if (Relaunch.ShouldHandOver(fileVersion, o.Version) && HandOver()) return;
            monitor.Observe(status, loopAlive, Now());
            Render();
            Announce(monitor.Drain());
            var next = monitor.GetView(Now()).PollMs;
            if (pollSoonMs.HasValue) next = Math.Min(next, pollSoonMs.Value);
            pollSoonMs = null;
            SchedulePoll(next);
        }

        /// <summary>Runs on the UI thread; dropped once the window is gone.</summary>
        private void Post(Action action)
        {
            try
            {
                if (!shutDown && form.IsHandleCreated) form.BeginInvoke(action);
            }
            catch (InvalidOperationException)
            {
                // closing
            }
        }

        /// <summary>The exe on disk is another release: start it and leave it the icon.</summary>
        private bool HandOver()
        {
            try
            {
                Relaunch.StartNew(o.Exe);
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception || e is InvalidOperationException || e is IOException)
            {
                Program.Log("telinha-tray: could not start the updated tray: " + e.Message);
                return false;
            }
            Shutdown();
            return true;
        }

        // ------------------------------------------------------------ rendering

        private void Render()
        {
            if (shutDown) return;
            rendering = true;
            try
            {
                var v = monitor.GetView(Now());
                statusItem.Text = v.StatusLine;
                for (var i = 0; i < DetailSlots; i++)
                {
                    var on = i < v.Details.Count;
                    detailItems[i].Visible = on;
                    detailItems[i].Text = on ? v.Details[i] : "";
                }
                openItem.Enabled = v.Menu.Open;
                startItem.Enabled = v.Menu.Start;
                stopItem.Enabled = v.Menu.Stop;
                restartItem.Enabled = v.Menu.Restart;
                checkItem.Enabled = v.Menu.CheckUpdates;
                checkItem.Text = v.Menu.CheckLabel;
                updateItem.Enabled = v.Menu.UpdateNow;
                updateItem.Text = v.Menu.UpdateNowLabel;
                bool enabled;
                try
                {
                    enabled = autostart.IsEnabled();
                }
                catch (Exception e) when (e is System.Security.SecurityException || e is UnauthorizedAccessException || e is IOException)
                {
                    enabled = false;
                }
                autostartItem.Checked = enabled;
                SetIcon(v.Dot);
                icon.Text = Icons.Tooltip(v.Tooltip);
            }
            finally
            {
                rendering = false;
            }
        }

        private void SetIcon(Dot dot)
        {
            var size = Icons.TraySize();
            if (iconDot == dot && iconSize == size) return;
            var handle = Icons.WithDot(dot, size);
            var next = Icon.FromHandle(handle);
            icon.Icon = next;
            // The shell keeps its own copy: the old handle can go now.
            DestroyCurrentIcon();
            iconHandle = handle;
            iconObject = next;
            iconDot = dot;
            iconSize = size;
        }

        private void DestroyCurrentIcon()
        {
            if (iconObject != null) iconObject.Dispose();
            if (iconHandle != IntPtr.Zero) Native.DestroyIcon(iconHandle);
            iconObject = null;
            iconHandle = IntPtr.Zero;
        }

        private void Announce(List<Notification> list)
        {
            foreach (var n in list)
            {
                var kind = n.Kind == NotificationKind.UpdateAvailable || n.Kind == NotificationKind.UpdateApplied ? ToolTipIcon.Info : ToolTipIcon.Warning;
                Balloon(n.Text, kind);
            }
        }

        private void Balloon(string text, ToolTipIcon kind)
        {
            if (shutDown || string.IsNullOrEmpty(text)) return;
            icon.ShowBalloonTip(BalloonMs, "Telinha", text, kind);
        }

        /// <summary>A menu action that failed: the detail line, the tooltip and a red dot, never a balloon.</summary>
        private void Failed(string text)
        {
            monitor.SetResult(text, Now(), true);
            Render();
        }

        private void ShowMenu()
        {
            // NotifyIcon's own right-click path: it brings the menu to the foreground so it closes on click-away.
            var show = typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic);
            if (show != null) show.Invoke(icon, null);
        }

        // ------------------------------------------------------------ actions

        private bool OpenTelinha()
        {
            try
            {
                return Actions.OpenUrl(monitor.PublicUrl);
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception || e is InvalidOperationException)
            {
                Failed(s.T("actionFailed", "action", s.T("open"), "error", e.Message));
                return true;
            }
        }

        private void OpenLog()
        {
            try
            {
                actions.OpenLog();
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception || e is InvalidOperationException || e is IOException || e is UnauthorizedAccessException)
            {
                Failed(s.T("actionFailed", "action", s.T("openLog"), "error", e.Message));
            }
        }

        private void ToggleAutostart()
        {
            if (rendering) return;
            try
            {
                autostart.Set(autostartItem.Checked);
            }
            catch (Exception e) when (e is System.Security.SecurityException || e is UnauthorizedAccessException || e is IOException)
            {
                Failed(s.T("actionFailed", "action", s.T("autostart"), "error", e.Message));
            }
            Render();
        }

        private void DoStart()
        {
            RunService(UserActionKind.Start, () => actions.Start());
        }

        private void DoStop()
        {
            var supervised = monitor.Last != null && monitor.Last.Supervised;
            RunService(UserActionKind.Stop, () => actions.Stop(supervised));
        }

        private void DoRestart()
        {
            RunService(UserActionKind.Restart, () => actions.Restart());
        }

        /// <summary>Start, stop and restart: one at a time, quiet window opened before and re-armed after.</summary>
        private void RunService(UserActionKind kind, Func<ActionOutcome> work)
        {
            if (monitor.ActionInFlight) return;
            monitor.UserAction(kind, Now());
            monitor.ActionInFlight = true;
            Render();
            SchedulePoll(Monitor.POLL_AFTER_ACTION_MS);
            Background(work, outcome =>
            {
                monitor.ActionInFlight = false;
                monitor.UserAction(kind, Now());
                Apply(outcome);
            });
        }

        private void DoUpdate(string mode)
        {
            if (monitor.UpdateInFlight != null) return;
            var now = mode == "now";
            if (now) monitor.UserAction(UserActionKind.UpdateNow, Now());
            monitor.UpdateInFlight = mode;
            Render();
            Background(now ? (Func<ActionOutcome>)actions.UpdateNow : actions.CheckUpdates, outcome =>
            {
                monitor.UpdateInFlight = null;
                // A download and stage can take minutes: the quiet window starts again from here.
                if (now) monitor.UserAction(UserActionKind.UpdateNow, Now());
                Apply(outcome);
            });
        }

        private void Apply(ActionOutcome outcome)
        {
            var now = Now();
            if (outcome.RestartAccepted) monitor.ExpectRestart(now);
            // A failure shows like a success, in the detail line and tooltip, plus the red
            // dot: balloons are kept for the service going down, crash loops and updates.
            else monitor.SetResult(outcome.Text, now, !outcome.Ok);
            Render();
            SchedulePoll(Monitor.POLL_AFTER_ACTION_MS);
        }

        private void Background(Func<ActionOutcome> work, Action<ActionOutcome> done)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                ActionOutcome outcome;
                try
                {
                    outcome = work();
                }
                catch (Exception e)
                {
                    outcome = ActionOutcome.Failure(e.Message);
                }
                Post(() =>
                {
                    if (!shutDown) done(outcome);
                });
            });
        }

        // ------------------------------------------------------------ exit

        /// <summary>
        /// Quit, WM_CLOSE (taskkill, telinha tray stop), logoff and hand-over all end here:
        /// the icon goes first so none lingers next to the clock.
        /// </summary>
        private void Shutdown()
        {
            if (shutDown) return;
            shutDown = true;
            timer.Stop();
            try
            {
                icon.Visible = false;
                icon.Dispose();
            }
            catch (Exception e) when (e is InvalidOperationException || e is System.ComponentModel.Win32Exception)
            {
                // the shell is gone (logoff)
            }
            current = null;
            TrayState.RemoveIfOurs(o.Home.TrayJson, o.Pid);
            if (o.ReleaseMutex != null) o.ReleaseMutex();
            DestroyCurrentIcon();
            Application.Exit();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                timer.Dispose();
                // Already gone after Shutdown(); this covers any other way out of the message loop.
                if (!shutDown) icon.Visible = false;
                icon.Dispose();
                DestroyCurrentIcon();
                menu.Dispose();
                client.Dispose();
                if (!form.IsDisposed) form.Dispose();
            }
            base.Dispose(disposing);
        }

        /// <summary>
        /// The window taskkill and the session manager talk to. taskkill without /F only
        /// posts WM_CLOSE to visible top-level windows, so this one is shown, but fully
        /// transparent, 1x1 and off-screen, never activated, click-through, and a tool window
        /// so it has no taskbar button or Alt+Tab entry. (ShowInTaskbar=false would give it a
        /// hidden owner window instead, and a WM_CLOSE there would destroy this one unseen.)
        /// </summary>
        private sealed class HiddenForm : Form
        {
            private readonly Action onEnd;

            public HiddenForm(Action onEnd)
            {
                this.onEnd = onEnd;
                Text = "Telinha tray";
                FormBorderStyle = FormBorderStyle.None;
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-32000, -32000);
                Size = new Size(1, 1);
                Opacity = 0;
                CreateHandle();
            }

            protected override bool ShowWithoutActivation
            {
                get { return true; }
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    var cp = base.CreateParams;
                    cp.ExStyle = (cp.ExStyle | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE | Native.WS_EX_TRANSPARENT) & ~Native.WS_EX_APPWINDOW;
                    return cp;
                }
            }

            protected override void WndProc(ref Message m)
            {
                switch (m.Msg)
                {
                    case Native.WM_CLOSE:
                        onEnd();
                        return;
                    case Native.WM_QUERYENDSESSION:
                        // Never hold up a logoff or shutdown.
                        m.Result = new IntPtr(1);
                        return;
                    case Native.WM_ENDSESSION:
                        if (m.WParam != IntPtr.Zero) onEnd();
                        m.Result = IntPtr.Zero;
                        return;
                }
                base.WndProc(ref m);
            }

            protected override void OnHandleDestroyed(EventArgs e)
            {
                // Destroyed by anything but our own exit (a handle recreate aside): exit too, never linger windowless.
                if (!RecreatingHandle) onEnd();
                base.OnHandleDestroyed(e);
            }
        }
    }
}
