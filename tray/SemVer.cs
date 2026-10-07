using System;
using System.Globalization;

namespace Telinha.Tray
{
    /// <summary>
    /// Version order exactly as telinha's updater sorts tags (compareVersions()), so the
    /// tray never calls something newer that the service would not install.
    /// </summary>
    public static class SemVer
    {
        /// <summary>Negative, zero or positive: X.Y.Z[-pre], optional leading v, a prerelease ranks below its release.</summary>
        public static int Compare(string a, string b)
        {
            string[] xCore, yCore;
            string xPre, yPre;
            Split(a, out xCore, out xPre);
            Split(b, out yCore, out yPre);
            for (var i = 0; i < Math.Max(xCore.Length, yCore.Length); i++)
            {
                var d = (i < xCore.Length ? CoreNumber(xCore[i]) : 0) - (i < yCore.Length ? CoreNumber(yCore[i]) : 0);
                // NaN (Infinity - Infinity) is falsy in JS: the position counts as equal.
                if (d != 0 && !double.IsNaN(d)) return Math.Sign(d);
            }
            if (xPre.Length == 0 && yPre.Length == 0) return 0;
            if (xPre.Length == 0) return 1;
            if (yPre.Length == 0) return -1;
            var xs = xPre.Split('.');
            var ys = yPre.Split('.');
            for (var i = 0; i < Math.Max(xs.Length, ys.Length); i++)
            {
                if (i >= xs.Length) return -1;
                if (i >= ys.Length) return 1;
                var p = xs[i];
                var q = ys[i];
                var np = JsNumber(p);
                var nq = JsNumber(q);
                int c;
                if (IsInteger(np) && IsInteger(nq))
                {
                    var diff = np - nq;
                    c = double.IsNaN(diff) ? 0 : Math.Sign(diff);
                }
                else
                {
                    c = Math.Sign(string.CompareOrdinal(p, q));
                }
                if (c != 0) return c;
            }
            return 0;
        }

        private static void Split(string v, out string[] core, out string pre)
        {
            v = v ?? "";
            if (v.StartsWith("v", StringComparison.Ordinal)) v = v.Substring(1);
            var dash = v.IndexOf('-');
            var coreText = dash < 0 ? v : v.Substring(0, dash);
            pre = dash < 0 ? "" : v.Substring(dash + 1);
            core = coreText.Split('.');
        }

        /// <summary><c>Number(n) || 0</c></summary>
        private static double CoreNumber(string s)
        {
            var n = JsNumber(s);
            return double.IsNaN(n) ? 0 : n;
        }

        private static bool IsInteger(double n)
        {
            return !double.IsNaN(n) && !double.IsInfinity(n) && Math.Floor(n) == n;
        }

        /// <summary>JavaScript's Number(string): trimmed, "" is 0, decimal or 0x/0o/0b, Infinity; anything else NaN.</summary>
        public static double JsNumber(string s)
        {
            var t = EnvFile.Trim(s ?? "");
            if (t.Length == 0) return 0;
            if (t.Length > 2 && t[0] == '0')
            {
                var radix = char.ToLowerInvariant(t[1]) == 'x' ? 16 : char.ToLowerInvariant(t[1]) == 'o' ? 8 : char.ToLowerInvariant(t[1]) == 'b' ? 2 : 0;
                if (radix != 0)
                {
                    double value = 0;
                    for (var i = 2; i < t.Length; i++)
                    {
                        var digit = Digit(t[i]);
                        if (digit < 0 || digit >= radix) return double.NaN;
                        value = value * radix + digit;
                    }
                    return value;
                }
            }
            var body = t[0] == '+' || t[0] == '-' ? t.Substring(1) : t;
            if (body == "Infinity") return t[0] == '-' ? double.NegativeInfinity : double.PositiveInfinity;
            // Digits, at most one dot and an exponent: the only other spellings Number() takes.
            var seenDigit = false;
            var seenDot = false;
            var seenExp = false;
            for (var i = 0; i < body.Length; i++)
            {
                var c = body[i];
                if (c >= '0' && c <= '9') seenDigit = true;
                else if (c == '.' && !seenDot && !seenExp) seenDot = true;
                else if ((c == 'e' || c == 'E') && seenDigit && !seenExp)
                {
                    seenExp = true;
                    if (i + 1 < body.Length && (body[i + 1] == '+' || body[i + 1] == '-')) i++;
                    if (i + 1 >= body.Length) return double.NaN;
                }
                else return double.NaN;
            }
            if (!seenDigit) return double.NaN;
            double result;
            return double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out result) ? result : double.NaN;
        }

        private static int Digit(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            c = char.ToLowerInvariant(c);
            if (c >= 'a' && c <= 'z') return c - 'a' + 10;
            return -1;
        }
    }
}
