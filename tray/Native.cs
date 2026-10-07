using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace Telinha.Tray
{
    /// <summary>The few Win32 calls WinForms does not wrap.</summary>
    internal static class Native
    {
        public const int WM_CLOSE = 0x0010;
        public const int WM_QUERYENDSESSION = 0x0011;
        public const int WM_ENDSESSION = 0x0016;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_TRANSPARENT = 0x00000020;
        public const int WS_EX_APPWINDOW = 0x00040000;
        public const int WS_EX_NOACTIVATE = 0x08000000;

        private const int ATTACH_PARENT_PROCESS = -1;
        private const int STD_OUTPUT_HANDLE = -11;
        private const uint FILE_TYPE_DISK = 0x0001;
        private const uint FILE_TYPE_PIPE = 0x0003;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int handle);

        [DllImport("kernel32.dll")]
        private static extern uint GetFileType(IntPtr handle);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr handle);

        private const int TokenElevationTypeClass = 18;
        private const int TokenElevationTypeFull = 2;

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, out int value, int length, out int returned);

        /// <summary>
        /// Elevated through UAC (a split token at its full half). A standard user, an
        /// administrator with UAC off and the built-in Administrator have a default
        /// token: nothing on their desktop runs at a lower level, so none of them is.
        /// When Windows will not say, any Administrators token counts.
        /// </summary>
        public static bool IsUacElevated()
        {
            using (var identity = WindowsIdentity.GetCurrent())
            {
                int type, returned;
                if (GetTokenInformation(identity.Token, TokenElevationTypeClass, out type, sizeof(int), out returned)) return type == TokenElevationTypeFull;
                return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
            }
        }

        /// <summary>
        /// A WinExe has no console of its own: output that is redirected (a pipe or a
        /// file) is written as is, otherwise it goes to the console of whoever started it.
        /// </summary>
        public static void WriteToParentConsole(string text)
        {
            var handle = GetStdHandle(STD_OUTPUT_HANDLE);
            var type = handle == IntPtr.Zero || handle == new IntPtr(-1) ? 0 : GetFileType(handle);
            if (type != FILE_TYPE_DISK && type != FILE_TYPE_PIPE) AttachConsole(ATTACH_PARENT_PROCESS);
            try
            {
                using (var stdout = Console.OpenStandardOutput())
                {
                    var bytes = new UTF8Encoding(false).GetBytes(text);
                    stdout.Write(bytes, 0, bytes.Length);
                    stdout.Flush();
                }
            }
            catch (IOException)
            {
                // nobody is listening
            }
        }
    }
}
