using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Windows.Forms;

namespace Telinha.Tray
{
    /// <summary>The embedded telinha.ico with a status dot drawn over its bottom-right corner.</summary>
    public static class Icons
    {
        /// <summary>The .NET Framework refuses a longer NotifyIcon.Text.</summary>
        public const int MaxTooltip = 63;

        public static readonly Color Green = ColorTranslator.FromHtml("#3ba55d");
        public static readonly Color Grey = ColorTranslator.FromHtml("#80848e");
        public static readonly Color Red = ColorTranslator.FromHtml("#ed4245");
        public static readonly Color Amber = ColorTranslator.FromHtml("#faa61a");

        public static Color ColorOf(Dot dot)
        {
            switch (dot)
            {
                case Dot.Green: return Green;
                case Dot.Red: return Red;
                case Dot.Amber: return Amber;
                default: return Grey;
            }
        }

        /// <summary>The tray's small-icon size for the current DPI: 16, 20, 24 or 32.</summary>
        public static int TraySize()
        {
            var want = SystemInformation.SmallIconSize.Width;
            var best = 16;
            foreach (var s in new[] { 16, 20, 24, 32 })
            {
                if (Math.Abs(s - want) < Math.Abs(best - want)) best = s;
            }
            return best;
        }

        /// <summary>The embedded base icon at <paramref name="size"/>.</summary>
        public static Icon Base(int size)
        {
            using (var stream = typeof(Icons).Assembly.GetManifestResourceStream("telinha.ico"))
            {
                if (stream == null) return (Icon)SystemIcons.Application.Clone();
                return new Icon(stream, size, size);
            }
        }

        /// <summary>
        /// A new HICON: the base with the dot (3/8 of the size) in a transparent ring so it
        /// reads on any taskbar. The caller owns the handle and must DestroyIcon it.
        /// </summary>
        public static IntPtr WithDot(Dot dot, int size)
        {
            using (var baseIcon = Base(size))
            using (var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.Transparent);
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    using (var image = baseIcon.ToBitmap())
                    {
                        g.DrawImage(image, new Rectangle(0, 0, size, size));
                    }
                    var d = size * 3f / 8f;
                    var ring = Math.Max(1f, size / 16f);
                    var x = size - d;
                    var y = size - d;
                    g.CompositingMode = CompositingMode.SourceCopy;
                    using (var clear = new SolidBrush(Color.Transparent))
                    {
                        g.FillEllipse(clear, x - ring, y - ring, d + ring * 2, d + ring * 2);
                    }
                    g.CompositingMode = CompositingMode.SourceOver;
                    using (var brush = new SolidBrush(ColorOf(dot)))
                    {
                        g.FillEllipse(brush, x, y, d - 0.5f, d - 0.5f);
                    }
                }
                return bmp.GetHicon();
            }
        }

        /// <summary>Tooltip text cut to what NotifyIcon accepts.</summary>
        public static string Tooltip(string text)
        {
            text = text ?? "";
            return text.Length <= MaxTooltip ? text : text.Substring(0, MaxTooltip - 1) + "…";
        }
    }
}
