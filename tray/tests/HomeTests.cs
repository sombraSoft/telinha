using System;
using System.Collections.Generic;
using Microsoft.VisualStudio.TestTools.UnitTesting;

[assembly: Parallelize(Workers = 0, Scope = ExecutionScope.MethodLevel)]

namespace Telinha.Tray.Tests
{
    [TestClass]
    public class HomeTests
    {
        private const string LocalAppData = @"C:\Users\ana\AppData\Local";

        private static Dictionary<string, string> Env(params string[] pairs)
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { { "LOCALAPPDATA", LocalAppData } };
            for (var i = 0; i + 1 < pairs.Length; i += 2) d[pairs[i]] = pairs[i + 1];
            return d;
        }

        private static readonly Func<string, bool> Nothing = p => false;

        [TestMethod]
        public void TelinhaHomeWins()
        {
            var h = Home.Resolve(Env("TELINHA_HOME", @"D:\custom"), @"C:\Users\ana\AppData\Local\Telinha\bin\telinha-tray.exe", Nothing);
            Assert.AreEqual(@"D:\custom", h.Root);
            Assert.AreEqual(@"D:\custom\bin", h.Bin);
            Assert.AreEqual(@"D:\custom\config\telinha.env", h.EnvFile);
            Assert.AreEqual(@"D:\custom\data\run\control.token", h.TokenFile);
            Assert.AreEqual(@"D:\custom\data\run\service.pid", h.ServicePid);
            Assert.AreEqual(@"D:\custom\data\run\tray.json", h.TrayJson);
            Assert.AreEqual(@"D:\custom\logs\telinha.log", h.LogFile);
            Assert.AreEqual(@"D:\custom\logs\telinha-tray.log", h.TrayLog);
        }

        [TestMethod]
        public void EmptyTelinhaHomeCountsAsUnset()
        {
            var h = Home.Resolve(Env("TELINHA_HOME", ""), @"C:\Users\ana\Downloads\telinha-tray.exe", Nothing);
            Assert.AreEqual(LocalAppData + @"\Telinha", h.Root);
        }

        [TestMethod]
        public void ExeInBinOfAFolderNamedTelinha()
        {
            var h = Home.Resolve(Env(), @"E:\Apps\TELINHA\Bin\telinha-tray.exe", Nothing);
            Assert.AreEqual(@"E:\Apps\TELINHA", h.Root);
            Assert.AreEqual(@"E:\Apps\TELINHA\bin", h.Bin);
            Assert.AreEqual(@"E:\Apps\TELINHA\Bin", h.TrayDir);
        }

        [TestMethod]
        public void ExeInBinOfAFolderWithConfig()
        {
            Func<string, bool> exists = p => p == @"D:\srv\config\telinha.env";
            var h = Home.Resolve(Env(), @"D:\srv\bin\telinha-tray.exe", exists);
            Assert.AreEqual(@"D:\srv", h.Root);
        }

        [TestMethod]
        public void DownloadFolderFallsBackToLocalAppData()
        {
            Assert.AreEqual(LocalAppData + @"\Telinha", Home.Resolve(Env(), @"C:\Users\ana\Downloads\telinha-tray.exe", Nothing).Root);
            // A bin folder that is no home (no config, not named telinha).
            Assert.AreEqual(LocalAppData + @"\Telinha", Home.Resolve(Env(), @"D:\tools\bin\telinha-tray.exe", Nothing).Root);
            Assert.IsNull(Home.HomeOfExe(@"C:\bin\telinha-tray.exe", Nothing));
        }

        [TestMethod]
        public void NoLocalAppDataUsesTheProfile()
        {
            var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { { "USERPROFILE", @"C:\Users\bia" } };
            Assert.AreEqual(@"C:\Users\bia\AppData\Local\Telinha", Home.Resolve(env, @"C:\x\telinha-tray.exe", Nothing).Root);
        }

        [TestMethod]
        public void DirectoryOverrides()
        {
            var h = Home.Resolve(Env("TELINHA_HOME", @"D:\t", "BIN_DIR", @"E:\bin", "DATA_DIR", @"F:\data", "TELINHA_ENV", @"G:\my.env"), @"D:\t\bin\telinha-tray.exe", Nothing);
            Assert.AreEqual(@"E:\bin", h.Bin);
            Assert.AreEqual(@"E:\bin\telinha.exe", h.TelinhaExe);
            Assert.AreEqual(@"F:\data", h.Data);
            Assert.AreEqual(@"F:\data\run", h.Run);
            Assert.AreEqual(@"F:\data\run\control.token", h.TokenFile);
            Assert.AreEqual(@"F:\data\run\service.pid", h.ServicePid);
            Assert.AreEqual(@"G:\my.env", h.EnvFile);
            Assert.AreEqual(@"D:\t\config", h.Config);
            Assert.AreEqual(@"D:\t\logs", h.Logs);
        }

        [TestMethod]
        public void TelinhaExeIsInBinElseNextToTheTray()
        {
            const string tray = @"C:\dev\tray\telinha-tray.exe";
            var env = Env("TELINHA_HOME", @"D:\t");
            Assert.AreEqual(@"D:\t\bin\telinha.exe", Home.Resolve(env, tray, p => p == @"D:\t\bin\telinha.exe").TelinhaExe);
            Assert.AreEqual(@"C:\dev\tray\telinha.exe", Home.Resolve(env, tray, p => p == @"C:\dev\tray\telinha.exe").TelinhaExe);
            Assert.AreEqual(@"D:\t\bin\telinha.exe", Home.Resolve(env, tray, Nothing).TelinhaExe);
        }

        [TestMethod]
        public void MutexNameIsPerHomeIgnoringCase()
        {
            var a = Program.MutexName(@"C:\Users\Ana\AppData\Local\Telinha");
            Assert.AreEqual(a, Program.MutexName(@"c:\users\ana\appdata\local\telinha\"));
            Assert.AreNotEqual(a, Program.MutexName(@"D:\other"));
            StringAssert.StartsWith(a, @"Local\Telinha.Tray.");
            Assert.AreEqual(@"Local\Telinha.Tray.".Length + 16, a.Length);
        }
    }
}
