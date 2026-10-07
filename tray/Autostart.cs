using System;
using System.IO;
using Microsoft.Win32;

namespace Telinha.Tray
{
    /// <summary>One registry value; the app uses HKCU, tests a fake.</summary>
    public interface IRegistryValue
    {
        /// <summary>The value's data, or null when it does not exist.</summary>
        string Get();
        void Set(string value);
        void Delete();
    }

    /// <summary>
    /// "Start with Windows": HKCU\Software\Microsoft\Windows\CurrentVersion\Run, value
    /// Telinha, data the quoted path of the tray exe (what `telinha tray autostart` writes).
    /// </summary>
    public sealed class Autostart
    {
        public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public const string ValueName = "Telinha";

        private readonly IRegistryValue value;
        private readonly string exe;

        public Autostart(IRegistryValue value, string exe)
        {
            this.value = value;
            this.exe = exe;
        }

        /// <summary>The Run value's data: the full path in quotes, so a path with spaces starts.</summary>
        public static string Render(string exe)
        {
            return "\"" + exe + "\"";
        }

        /// <summary>The program a Run value starts: the quoted path, or an unquoted one up to the first space; null when empty.</summary>
        public static string Parse(string data)
        {
            if (string.IsNullOrWhiteSpace(data)) return null;
            var t = data.Trim();
            if (t[0] == '"')
            {
                var end = t.IndexOf('"', 1);
                var path = end < 0 ? t.Substring(1) : t.Substring(1, end - 1);
                return path.Length == 0 ? null : path;
            }
            var space = t.IndexOf(' ');
            return space < 0 ? t : t.Substring(0, space);
        }

        /// <summary>The Run value starts this tray exe.</summary>
        public bool IsEnabled()
        {
            var path = Parse(value.Get());
            return path != null && string.Equals(Normalize(path), Normalize(exe), StringComparison.OrdinalIgnoreCase);
        }

        public void Set(bool on)
        {
            if (on) value.Set(Render(exe));
            else value.Delete();
        }

        private static string Normalize(string path)
        {
            try
            {
                return Path.GetFullPath(path);
            }
            catch (Exception e) when (e is ArgumentException || e is NotSupportedException || e is PathTooLongException || e is System.Security.SecurityException)
            {
                return path;
            }
        }
    }

    /// <summary>A REG_SZ value under HKCU.</summary>
    public sealed class HkcuValue : IRegistryValue
    {
        private readonly string key;
        private readonly string name;

        public HkcuValue(string key, string name)
        {
            this.key = key;
            this.name = name;
        }

        public string Get()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(key, false))
            {
                return k == null ? null : k.GetValue(name) as string;
            }
        }

        public void Set(string value)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(key))
            {
                k.SetValue(name, value, RegistryValueKind.String);
            }
        }

        public void Delete()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(key, true))
            {
                if (k != null) k.DeleteValue(name, false);
            }
        }
    }

    /// <summary>HKCU\Software\Telinha\Tray: the tags already announced, so a tray restart does not repeat a balloon.</summary>
    public sealed class RegistryNotifiedStore : INotifiedStore
    {
        public const string Key = @"Software\Telinha\Tray";

        public string Get(string name)
        {
            return new HkcuValue(Key, name).Get();
        }

        public void Set(string name, string value)
        {
            new HkcuValue(Key, name).Set(value);
        }
    }
}
