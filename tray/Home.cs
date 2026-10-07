using System;
using System.Collections.Generic;
using System.IO;

namespace Telinha.Tray
{
    /// <summary>
    /// The install's folders, resolved like telinha's own paths: TELINHA_HOME, else the
    /// home an installed exe lives in (&lt;home&gt;\bin\...), else %LOCALAPPDATA%\Telinha.
    /// </summary>
    public sealed class Home
    {
        public string Root { get; private set; }
        public string Bin { get; private set; }
        public string Config { get; private set; }
        public string Data { get; private set; }
        public string Run { get; private set; }
        public string Logs { get; private set; }
        /// <summary>logs\telinha.log: the service log.</summary>
        public string LogFile { get; private set; }
        /// <summary>logs\telinha-tray.log: the tray's own crash and refusal lines.</summary>
        public string TrayLog { get; private set; }
        /// <summary>TELINHA_ENV, else config\telinha.env.</summary>
        public string EnvFile { get; private set; }
        public string TokenFile { get; private set; }
        /// <summary>The service loop's pid (written by telinha service run).</summary>
        public string ServicePid { get; private set; }
        public string TrayJson { get; private set; }
        /// <summary>bin\telinha.exe, else the one next to the tray.</summary>
        public string TelinhaExe { get; private set; }
        /// <summary>The folder the tray runs from.</summary>
        public string TrayDir { get; private set; }

        public static Home Resolve(IDictionary<string, string> env, string trayExe, Func<string, bool> fileExists = null)
        {
            var exists = fileExists ?? File.Exists;
            Func<string, string> set = k =>
            {
                string v;
                return env != null && env.TryGetValue(k, out v) && !string.IsNullOrEmpty(v) ? v : null;
            };
            var root = set("TELINHA_HOME")
                ?? HomeOfExe(trayExe, exists)
                ?? Path.Combine(set("LOCALAPPDATA") ?? Path.Combine(set("USERPROFILE") ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "Local"), "Telinha");
            var data = set("DATA_DIR") ?? Path.Combine(root, "data");
            var run = Path.Combine(data, "run");
            var logs = Path.Combine(root, "logs");
            var config = Path.Combine(root, "config");
            var bin = set("BIN_DIR") ?? Path.Combine(root, "bin");
            var trayDir = Path.GetDirectoryName(trayExe) ?? ".";
            var inBin = Path.Combine(bin, "telinha.exe");
            var nextToTray = Path.Combine(trayDir, "telinha.exe");
            return new Home
            {
                Root = root,
                Bin = bin,
                Config = config,
                Data = data,
                Run = run,
                Logs = logs,
                LogFile = Path.Combine(logs, "telinha.log"),
                TrayLog = Path.Combine(logs, "telinha-tray.log"),
                EnvFile = set("TELINHA_ENV") ?? Path.Combine(config, "telinha.env"),
                TokenFile = Path.Combine(run, "control.token"),
                ServicePid = Path.Combine(run, "service.pid"),
                TrayJson = Path.Combine(run, "tray.json"),
                TelinhaExe = !exists(inBin) && exists(nextToTray) ? nextToTray : inBin,
                TrayDir = trayDir,
            };
        }

        /// <summary>
        /// &lt;home&gt;\bin\telinha-tray.exe belongs to &lt;home&gt; when that folder is named
        /// telinha or already holds config\telinha.env; anything else (a download folder) is no home.
        /// </summary>
        public static string HomeOfExe(string exe, Func<string, bool> fileExists = null)
        {
            var exists = fileExists ?? File.Exists;
            if (string.IsNullOrEmpty(exe)) return null;
            var dir = Path.GetDirectoryName(exe);
            if (string.IsNullOrEmpty(dir) || !string.Equals(Path.GetFileName(dir), "bin", StringComparison.OrdinalIgnoreCase)) return null;
            var home = Path.GetDirectoryName(dir);
            if (string.IsNullOrEmpty(home) || home == dir) return null;
            if (string.Equals(Path.GetFileName(home), "telinha", StringComparison.OrdinalIgnoreCase)) return home;
            return exists(Path.Combine(home, "config", "telinha.env")) ? home : null;
        }
    }
}
