using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Telinha.Tray
{
    /// <summary>
    /// telinha.env, read the way the server reads it: no interpolation, no unescaping,
    /// no inline comments; matching outer quotes are dropped.
    /// </summary>
    public static class EnvFile
    {
        private static readonly Regex KeyRe = new Regex(@"^[A-Za-z_][A-Za-z0-9_]*\z", RegexOptions.CultureInvariant);
        private static readonly Regex ExportRe = new Regex(@"^export\s+", RegexOptions.CultureInvariant);
        private static readonly Regex LineBreak = new Regex(@"\r?\n", RegexOptions.CultureInvariant);

        public static Dictionary<string, string> Parse(string text)
        {
            var vars = new Dictionary<string, string>(StringComparer.Ordinal);
            if (text == null) return vars;
            // Notepad may save a BOM, which would make the first key invalid.
            if (text.Length > 0 && text[0] == '﻿') text = text.Substring(1);
            foreach (var raw in LineBreak.Split(text))
            {
                var line = Trim(raw);
                if (line.Length == 0 || line[0] == '#') continue;
                var body = ExportRe.Replace(line, "", 1);
                var eq = body.IndexOf('=');
                if (eq < 0) continue;
                var key = Trim(body.Substring(0, eq));
                if (!KeyRe.IsMatch(key)) continue;
                var value = Trim(body.Substring(eq + 1));
                if (value.Length >= 2 && (value[0] == '"' || value[0] == '\'') && value[value.Length - 1] == value[0])
                {
                    value = value.Substring(1, value.Length - 2);
                }
                vars[key] = value;
            }
            return vars;
        }

        /// <summary>Empty when the file is missing or unreadable: the environment alone then, like the CLI.</summary>
        public static Dictionary<string, string> Load(string path)
        {
            try
            {
                return Parse(File.ReadAllText(path, new UTF8Encoding(false)));
            }
            catch (Exception e) when (e is IOException || e is UnauthorizedAccessException || e is ArgumentException || e is NotSupportedException)
            {
                return new Dictionary<string, string>(StringComparer.Ordinal);
            }
        }

        /// <summary>The real environment wins over the file, except variables set to "".</summary>
        public static Dictionary<string, string> Merge(IDictionary<string, string> file, IDictionary<string, string> processEnv)
        {
            var merged = new Dictionary<string, string>(StringComparer.Ordinal);
            if (file != null) foreach (var kv in file) merged[kv.Key] = kv.Value;
            if (processEnv != null)
            {
                foreach (var kv in processEnv)
                {
                    if (!string.IsNullOrEmpty(kv.Value)) merged[kv.Key] = kv.Value;
                }
            }
            return merged;
        }

        /// <summary>
        /// The process environment as a dictionary. Windows variable names ignore case,
        /// so lookups do too (Bun's process.env behaves the same there).
        /// </summary>
        public static Dictionary<string, string> FromProcess(IDictionary env)
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (env == null) return d;
            foreach (DictionaryEntry e in env)
            {
                var k = e.Key as string;
                if (k != null) d[k] = e.Value as string ?? "";
            }
            return d;
        }

        /// <summary>JavaScript's String.prototype.trim(): whitespace, line terminators and the BOM.</summary>
        internal static string Trim(string s)
        {
            int start = 0, end = s.Length;
            while (start < end && IsJsSpace(s[start])) start++;
            while (end > start && IsJsSpace(s[end - 1])) end--;
            return s.Substring(start, end - start);
        }

        private static bool IsJsSpace(char c)
        {
            return char.IsWhiteSpace(c) || c == '﻿';
        }
    }
}
