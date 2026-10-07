using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

namespace Telinha.Tray
{
    /// <summary>
    /// An update swaps telinha-tray.exe under the running tray (Windows lets a running exe
    /// be renamed aside). The tray notices its file now carries another release version
    /// and hands over to it.
    /// </summary>
    public static class Relaunch
    {
        public const string Flag = "--relaunched";

        /// <summary>The running release version: InformationalVersion, the same string as the file's ProductVersion.</summary>
        public static string RunningVersion()
        {
            var assembly = Assembly.GetEntryAssembly() ?? typeof(Relaunch).Assembly;
            var attr = (AssemblyInformationalVersionAttribute)Attribute.GetCustomAttribute(assembly, typeof(AssemblyInformationalVersionAttribute));
            var v = attr == null ? null : attr.InformationalVersion;
            return string.IsNullOrWhiteSpace(v) ? "0.0.0" : v.Trim();
        }

        /// <summary>
        /// ProductVersion of the file at <paramref name="path"/>, trimmed; null when it is
        /// missing, locked or has none. ProductVersion, not FileVersion: FileVersion drops
        /// the -rc.N part, so rc.1 to rc.2 would never relaunch. Read from a copy: asked
        /// for our own path, Windows answers from the image already loaded in this process
        /// (the loader matches by path), never from the new file now there.
        /// </summary>
        public static string FileProductVersion(string path)
        {
            string copy = null;
            try
            {
                if (!File.Exists(path)) return null;
                copy = Path.Combine(Path.GetTempPath(), "telinha-tray-" + Guid.NewGuid().ToString("N") + ".tmp");
                File.Copy(path, copy);
                var v = FileVersionInfo.GetVersionInfo(copy).ProductVersion;
                return string.IsNullOrWhiteSpace(v) ? null : v.Trim();
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is ArgumentException || e is NotSupportedException)
            {
                return null;
            }
            finally
            {
                if (copy != null)
                {
                    try
                    {
                        File.Delete(copy);
                    }
                    catch (Exception e) when (e is IOException || e is UnauthorizedAccessException)
                    {
                        // a stray temp file at worst
                    }
                }
            }
        }

        public static bool ShouldHandOver(string fileVersion, string runningVersion)
        {
            return !string.IsNullOrEmpty(fileVersion) && !string.Equals(fileVersion, runningVersion, StringComparison.Ordinal);
        }

        /// <summary>Starts the new exe; it waits for our mutex, so the caller exits right after.</summary>
        public static void StartNew(string path)
        {
            using (Process.Start(new ProcessStartInfo(path, Flag) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(path) ?? "" }))
            {
            }
        }

        /// <summary>
        /// Our own exe, looked at on each poll: its version is only read again when its size
        /// or times changed, so an unchanged file costs one stat.
        /// </summary>
        public sealed class Watch
        {
            private readonly string path;
            private string stamp;

            public Watch(string path)
            {
                this.path = path;
                stamp = Stamp(path);
            }

            /// <summary>The file's ProductVersion when the file changed since the last look, else null.</summary>
            public string ChangedVersion()
            {
                var now = Stamp(path);
                if (now == null || now == stamp) return null;
                var version = FileProductVersion(path);
                // Unreadable (still being written, locked): look again next time.
                if (version != null) stamp = now;
                return version;
            }

            private static string Stamp(string path)
            {
                try
                {
                    var info = new FileInfo(path);
                    if (!info.Exists) return null;
                    return info.Length + "|" + info.LastWriteTimeUtc.Ticks + "|" + info.CreationTimeUtc.Ticks;
                }
                catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is ArgumentException || e is NotSupportedException)
                {
                    return null;
                }
            }
        }
    }
}
