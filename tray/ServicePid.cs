using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

namespace Telinha.Tray
{
    /// <summary>
    /// data\run\service.pid: the pid of the `telinha service run` loop. While that loop
    /// lives, a Telinha that does not answer is starting (or restarting), not down.
    /// </summary>
    public static class ServicePid
    {
        private static readonly Regex Decimal = new Regex(@"^[0-9]{1,10}\z", RegexOptions.CultureInvariant);

        /// <summary>The file's pid; null when it is missing, empty or not a number.</summary>
        public static int? Read(string path)
        {
            string text;
            try
            {
                text = File.ReadAllText(path);
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is ArgumentException || e is NotSupportedException)
            {
                return null;
            }
            return Parse(text);
        }

        public static int? Parse(string text)
        {
            var t = EnvFile.Trim(text ?? "");
            int pid;
            if (!Decimal.IsMatch(t) || !int.TryParse(t, NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid <= 0) return null;
            return pid;
        }

        /// <summary>
        /// The pid runs telinha.exe. A pid Windows reused for another image is not the
        /// loop. <paramref name="processName"/> answers the image name of a live pid, or null.
        /// </summary>
        public static bool IsLive(int pid, Func<int, string> processName = null)
        {
            var name = (processName ?? ProcessNameOf)(pid);
            return name != null && string.Equals(name, "telinha", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>The loop named in <paramref name="path"/> is alive; false when the file is missing (a console run, no service).</summary>
        public static bool LoopAlive(string path, Func<int, string> processName = null)
        {
            var pid = Read(path);
            return pid.HasValue && IsLive(pid.Value, processName);
        }

        /// <summary>
        /// Image name without .exe of a running process; null when it is gone or cannot be asked.
        /// It must never need a process handle: the loop runs in session 0 as an S4U
        /// scheduled task, and from the user's desktop OpenProcess on it (and so
        /// HasExited) is denied. GetProcessById throws ArgumentException for a pid that
        /// is not running, and ProcessName comes from the system's process snapshot.
        /// </summary>
        public static string ProcessNameOf(int pid)
        {
            try
            {
                using (var p = Process.GetProcessById(pid))
                {
                    return p.ProcessName;
                }
            }
            catch (Exception e) when (e is ArgumentException || e is InvalidOperationException || e is System.ComponentModel.Win32Exception || e is NotSupportedException)
            {
                return null;
            }
        }
    }
}
