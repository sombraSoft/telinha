using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Telinha.Tray
{
    public static class Program
    {
        /// <summary>The crash log is cut back to nothing past this size.</summary>
        private const long LogCapBytes = 1024 * 1024;

        private static string logPath;

        [STAThread]
        public static int Main(string[] args)
        {
            var showVersion = false;
            var relaunched = false;
            foreach (var a in args)
            {
                if (a == "--version" || a == "-v") showVersion = true;
                else if (a == Relaunch.Flag) relaunched = true;
            }
            var version = Relaunch.RunningVersion();
            if (showVersion)
            {
                Native.WriteToParentConsole("telinha-tray " + version + "\n");
                return 0;
            }

            try
            {
                return Run(version, relaunched);
            }
            catch (Exception e)
            {
                // Never a dialog: a tray that cannot run leaves a line and goes.
                Log("telinha-tray: " + OneLine(e));
                return 1;
            }
        }

        private static int Run(string version, bool relaunched)
        {
            var exe = Application.ExecutablePath;
            // Whoever started us may sit in a folder the user wants to delete later (the
            // unzipped download): a process's current directory cannot be removed.
            try
            {
                Environment.CurrentDirectory = Path.GetDirectoryName(exe);
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is ArgumentException || e is System.Security.SecurityException)
            {
                // stays where it was
            }
            var processEnv = EnvFile.FromProcess(Environment.GetEnvironmentVariables());
            var home = Home.Resolve(processEnv, exe);
            logPath = home.TrayLog;

            if (Native.IsUacElevated())
            {
                // An elevated tray cannot be stopped from a normal terminal, and UIPI blocks the shell's messages to it.
                // With UAC off (or as the built-in Administrator) everything runs at that level: no reason to refuse.
                Log("telinha-tray: refusing to run elevated; start it from a normal session");
                return 2;
            }

            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (s, e) => Crash(e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Crash(e.ExceptionObject as Exception);

            var merged = EnvFile.Merge(EnvFile.Load(home.EnvFile), processEnv);
            var locale = Strings.Pick(merged, CultureInfo.CurrentUICulture);
            var culture = new CultureInfo(locale == Strings.PtBr ? "pt-BR" : "en-US");
            Thread.CurrentThread.CurrentUICulture = culture;
            CultureInfo.DefaultThreadCurrentUICulture = culture;

            var mutex = new MutexHolder(MutexName(home.Root), relaunched);
            if (!mutex.Owned)
            {
                // Another tray already shows this home.
                mutex.Dispose();
                return 0;
            }

            var pid = System.Diagnostics.Process.GetCurrentProcess().Id;
            TrayState.Write(home.TrayJson, version, pid, NowMs(), exe);
            EventHandler cleanup = (s, e) => TrayState.RemoveIfOurs(home.TrayJson, pid);
            AppDomain.CurrentDomain.ProcessExit += cleanup;
            Application.ApplicationExit += cleanup;

            // An update call holds a connection for minutes; polls and actions need their own.
            ServicePointManager.DefaultConnectionLimit = Math.Max(ServicePointManager.DefaultConnectionLimit, 8);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var app = new TrayApp(new TrayOptions
            {
                Home = home,
                Version = version,
                Exe = exe,
                Pid = pid,
                Strings = new Strings(locale),
                ProcessEnv = processEnv,
                ReleaseMutex = mutex.Release,
            }))
            {
                Application.Run(app);
            }
            mutex.Release();
            mutex.Dispose();
            TrayState.RemoveIfOurs(home.TrayJson, pid);
            return 0;
        }

        private static void Crash(Exception e)
        {
            Log("telinha-tray: crashed: " + OneLine(e));
            TrayApp.EmergencyHide();
            Environment.Exit(1);
        }

        /// <summary>Local\Telinha.Tray.&lt;16 hex of sha1(home)&gt;: one tray per home and per session.</summary>
        public static string MutexName(string home)
        {
            var key = home ?? "";
            try
            {
                key = Path.GetFullPath(key).TrimEnd('\\', '/');
            }
            catch (Exception e) when (e is ArgumentException || e is NotSupportedException || e is PathTooLongException || e is System.Security.SecurityException)
            {
                // an odd TELINHA_HOME is still a key
            }
            return @"Local\Telinha.Tray." + Sha1Hex(key.ToLowerInvariant()).Substring(0, 16);
        }

        public static string Sha1Hex(string text)
        {
            using (var sha = SHA1.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(text));
                var sb = new StringBuilder(bytes.Length * 2);
                foreach (var b in bytes) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        public static long NowMs()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        /// <summary>One line in logs\telinha-tray.log; never throws.</summary>
        public static void Log(string line)
        {
            var path = logPath;
            if (path == null) return;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                var info = new FileInfo(path);
                if (info.Exists && info.Length > LogCapBytes) File.WriteAllText(path, "");
                File.AppendAllText(path, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) + " " + line + Environment.NewLine, new UTF8Encoding(false));
            }
            catch (Exception)
            {
                // nowhere left to say it
            }
        }

        private static string OneLine(Exception e)
        {
            if (e == null) return "unknown error";
            return (e.GetType().Name + ": " + e.Message + " " + (e.StackTrace ?? "")).Replace("\r", " ").Replace("\n", " ");
        }

        /// <summary>The single-instance mutex; released by the thread that owns it (the UI thread).</summary>
        private sealed class MutexHolder : IDisposable
        {
            private readonly Mutex mutex;

            public MutexHolder(string name, bool relaunched)
            {
                bool created;
                mutex = new Mutex(true, name, out created);
                Owned = created;
                if (created || !relaunched) return;
                // The old instance hands over: it exits right after starting us.
                try
                {
                    Owned = mutex.WaitOne(5000);
                }
                catch (AbandonedMutexException)
                {
                    Owned = true;
                }
            }

            public bool Owned { get; private set; }

            public void Release()
            {
                if (!Owned) return;
                Owned = false;
                try
                {
                    mutex.ReleaseMutex();
                }
                catch (ApplicationException)
                {
                    // not ours any more
                }
            }

            public void Dispose()
            {
                mutex.Dispose();
            }
        }
    }

    /// <summary>data\run\tray.json: what `telinha tray status` and the doctor read.</summary>
    public static class TrayState
    {
        public static void Write(string path, string version, int pid, long startedAt, string exe)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                var json = Json.Serialize(new Dictionary<string, object>
                {
                    { "version", version },
                    { "pid", pid },
                    { "startedAt", startedAt },
                    { "exe", exe },
                });
                // tmp + replace: a reader never sees half a file.
                var tmp = path + "." + pid.ToString(CultureInfo.InvariantCulture) + ".tmp";
                File.WriteAllText(tmp, json + "\n", new UTF8Encoding(false));
                if (File.Exists(path)) File.Replace(tmp, path, null);
                else File.Move(tmp, path);
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                Program.Log("telinha-tray: could not write " + path + ": " + e.Message);
            }
        }

        /// <summary>Only while the file still names our pid: a newer tray may own it already.</summary>
        public static void RemoveIfOurs(string path, int pid)
        {
            try
            {
                if (!File.Exists(path)) return;
                var d = Json.Object(File.ReadAllText(path));
                if (Json.Long(d, "pid") != pid) return;
                File.Delete(path);
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
            {
                // the next start overwrites it
            }
        }
    }
}
