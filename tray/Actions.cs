using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;

namespace Telinha.Tray
{
    /// <summary>What a menu action came to: the line for the detail line and tooltip, success or error.</summary>
    public sealed class ActionOutcome
    {
        public bool Ok;
        /// <summary>The result line when Ok, else the error line.</summary>
        public string Text;
        /// <summary>A restart was accepted: the monitor says "restarted" once Telinha answers again.</summary>
        public bool RestartAccepted;

        public static ActionOutcome Success(string text)
        {
            return new ActionOutcome { Ok = true, Text = text };
        }

        public static ActionOutcome Failure(string text)
        {
            return new ActionOutcome { Ok = false, Text = text };
        }
    }

    /// <summary>
    /// The menu's work: service start/stop through telinha.exe (hidden, 60 s cap), the
    /// rest through the control endpoint. Runs on a worker thread; nothing here touches UI.
    /// </summary>
    public sealed class Actions
    {
        public const int CliTimeoutMs = 60000;

        private readonly Home home;
        private readonly Strings s;
        private readonly ControlClient client;

        public Actions(Home home, Strings strings, ControlClient client)
        {
            this.home = home;
            s = strings;
            this.client = client;
        }

        public ActionOutcome Start()
        {
            if (!File.Exists(home.TelinhaExe)) return ActionOutcome.Failure(s.T("startFailed", "error", s.T("noExe", "dir", home.TrayDir)));
            var r = RunTelinha("service", "start");
            return r.ExitCode == 0
                ? ActionOutcome.Success(s.T("started"))
                : ActionOutcome.Failure(s.T("startFailed", "error", r.ErrorLine));
        }

        /// <summary>A supervised service is stopped through its manager; a console run is asked to stop itself.</summary>
        public ActionOutcome Stop(bool supervised)
        {
            if (supervised)
            {
                if (!File.Exists(home.TelinhaExe)) return Failed("stop", s.T("noExe", "dir", home.TrayDir));
                var r = RunTelinha("service", "stop");
                return r.ExitCode == 0 ? ActionOutcome.Success(s.T("stopped")) : Failed("stop", r.ErrorLine);
            }
            try
            {
                client.Shutdown("stop");
                return ActionOutcome.Success(s.T("stoppedConsole"));
            }
            catch (ControlException e)
            {
                return Failed("stop", e.Message);
            }
        }

        /// <summary>Only offered for a supervised service: the loop starts Telinha again.</summary>
        public ActionOutcome Restart()
        {
            try
            {
                client.Shutdown("restart");
                return new ActionOutcome { Ok = true, RestartAccepted = true };
            }
            catch (ControlException e)
            {
                return Failed("restart", e.Message);
            }
        }

        public ActionOutcome CheckUpdates()
        {
            try
            {
                return Describe(client.Update("check"), false);
            }
            catch (ControlException e)
            {
                return Failed("checkUpdates", e.Message);
            }
        }

        public ActionOutcome UpdateNow()
        {
            try
            {
                return Describe(client.Update("now"), true);
            }
            catch (ControlException e)
            {
                return Failed("updateNow", e.Message);
            }
        }

        /// <summary>The detail line for an update answer, in the CLI's words.</summary>
        public ActionOutcome Describe(UpdateResult r, bool now)
        {
            switch (r.Action)
            {
                case "staged":
                    return ActionOutcome.Success(s.T("installedRestart", "tag", r.StagedTag ?? r.Target ?? ""));
                case "failed":
                    return Failed(now ? "updateNow" : "checkUpdates", r.Message);
                case "pending":
                case "deferred":
                    return ActionOutcome.Success(r.Message);
                default:
                    // "now" with a target and nothing done: the service said why (not a native install).
                    if (now && r.Target != null && !string.IsNullOrEmpty(r.Message)) return ActionOutcome.Success(r.Message);
                    if (r.Target != null) return ActionOutcome.Success(s.T("notifyAvailable", "tag", r.Target));
                    if (r.Latest == null && r.Pin == null) return ActionOutcome.Success(s.T("latestUnknown"));
                    return ActionOutcome.Success(s.T("upToDate"));
            }
        }

        private ActionOutcome Failed(string actionKey, string error)
        {
            return ActionOutcome.Failure(s.T("actionFailed", "action", s.T(actionKey), "error", FirstLine(error)));
        }

        /// <summary>Opens PUBLIC_URL in the default browser; only an absolute http(s) URL is ever handed to the shell.</summary>
        public static bool OpenUrl(string publicUrl)
        {
            Uri uri;
            if (!Monitor.TryOpenUri(publicUrl, out uri)) return false;
            using (Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }))
            {
            }
            return true;
        }

        /// <summary>The service log with its default app; the logs folder when there is no log yet.</summary>
        public void OpenLog()
        {
            if (File.Exists(home.LogFile))
            {
                using (Process.Start(new ProcessStartInfo(home.LogFile) { UseShellExecute = true }))
                {
                }
                return;
            }
            Directory.CreateDirectory(home.Logs);
            using (Process.Start(new ProcessStartInfo("explorer.exe", Quote(home.Logs)) { UseShellExecute = false }))
            {
            }
        }

        public sealed class CliResult
        {
            public int ExitCode;
            public string Stdout = "";
            public string Stderr = "";

            /// <summary>The first stderr line, else the first stdout line: what the detail line can hold.</summary>
            public string ErrorLine
            {
                get
                {
                    var line = FirstLine(Stderr);
                    if (line.Length == 0) line = FirstLine(Stdout);
                    return line.Length == 0 ? "exit code " + ExitCode.ToString(CultureInfo.InvariantCulture) : line;
                }
            }
        }

        /// <summary>The telinha.exe arguments: the action's, then this home and the tray's language.</summary>
        public string[] CliArgs(params string[] args)
        {
            var all = new List<string>(args);
            all.Add("--home");
            all.Add(home.Root);
            all.Add("--lang");
            all.Add(s.Locale);
            return all.ToArray();
        }

        public CliResult RunTelinha(params string[] args)
        {
            var psi = new ProcessStartInfo(home.TelinhaExe, CommandLine(CliArgs(args)))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = home.TrayDir,
            };
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            try
            {
                using (var p = new Process { StartInfo = psi })
                {
                    p.OutputDataReceived += (o, e) => { if (e.Data != null) lock (stdout) stdout.AppendLine(e.Data); };
                    p.ErrorDataReceived += (o, e) => { if (e.Data != null) lock (stderr) stderr.AppendLine(e.Data); };
                    p.Start();
                    // No prompt can ever be answered from here.
                    p.StandardInput.Close();
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    if (!p.WaitForExit(CliTimeoutMs))
                    {
                        try
                        {
                            p.Kill();
                        }
                        catch (Exception e) when (e is InvalidOperationException || e is System.ComponentModel.Win32Exception)
                        {
                            // already gone
                        }
                        return new CliResult { ExitCode = -1, Stderr = s.T("timedOut", "s", CliTimeoutMs / 1000) };
                    }
                    // Flushes the async readers.
                    p.WaitForExit();
                    lock (stdout) lock (stderr) return new CliResult { ExitCode = p.ExitCode, Stdout = stdout.ToString(), Stderr = stderr.ToString() };
                }
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception || e is InvalidOperationException || e is IOException)
            {
                return new CliResult { ExitCode = -1, Stderr = e.Message };
            }
        }

        /// <summary>First non-empty line, trimmed.</summary>
        public static string FirstLine(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            foreach (var line in text.Split('\n'))
            {
                var t = line.Trim();
                if (t.Length > 0) return t;
            }
            return "";
        }

        public static string CommandLine(IEnumerable<string> args)
        {
            var sb = new StringBuilder();
            foreach (var a in args)
            {
                if (sb.Length > 0) sb.Append(' ');
                sb.Append(Quote(a));
            }
            return sb.ToString();
        }

        /// <summary>One argument quoted for CommandLineToArgvW: backslashes double only before a quote or the closing quote.</summary>
        public static string Quote(string arg)
        {
            if (arg == null) arg = "";
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            var sb = new StringBuilder("\"");
            var backslashes = 0;
            foreach (var c in arg)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(c);
                }
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }
    }
}
