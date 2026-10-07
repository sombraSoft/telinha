using System;
using System.Diagnostics;
using System.IO;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Telinha.Tray.Tests
{
    [TestClass]
    public class ServicePidTests
    {
        private string dir;

        [TestInitialize]
        public void Setup()
        {
            dir = Path.Combine(Path.GetTempPath(), "telinha-tray-pid-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
        }

        [TestCleanup]
        public void Cleanup()
        {
            Directory.Delete(dir, true);
        }

        private string PidFile(string content)
        {
            var p = Path.Combine(dir, "service.pid");
            File.WriteAllText(p, content);
            return p;
        }

        [TestMethod]
        public void MissingEmptyOrGarbageIsNull()
        {
            Assert.IsNull(ServicePid.Read(Path.Combine(dir, "service.pid")));
            Assert.IsNull(ServicePid.Read(PidFile("")));
            Assert.IsNull(ServicePid.Read(PidFile("   \r\n")));
            Assert.IsNull(ServicePid.Read(PidFile("12ab")));
            Assert.IsNull(ServicePid.Read(PidFile("-5")));
            Assert.IsNull(ServicePid.Read(PidFile("0")));
            Assert.IsNull(ServicePid.Read(PidFile("99999999999")));
        }

        [TestMethod]
        public void DecimalContentIsThePid()
        {
            Assert.AreEqual(4242, ServicePid.Read(PidFile("4242")));
            Assert.AreEqual(4242, ServicePid.Read(PidFile(" 4242\r\n")));
        }

        [TestMethod]
        public void LiveOnlyWhenTheImageIsTelinha()
        {
            Assert.IsTrue(ServicePid.IsLive(4242, pid => "telinha"));
            Assert.IsTrue(ServicePid.IsLive(4242, pid => "TELINHA"));
            // A pid Windows reused for another program.
            Assert.IsFalse(ServicePid.IsLive(4242, pid => "notepad"));
            Assert.IsFalse(ServicePid.IsLive(4242, pid => "telinha-tray"));
            // Gone.
            Assert.IsFalse(ServicePid.IsLive(4242, pid => null));
        }

        [TestMethod]
        public void LoopAliveReadsTheFileThenProbes()
        {
            var probed = 0;
            Func<int, string> probe = pid =>
            {
                probed = pid;
                return "telinha";
            };
            Assert.IsFalse(ServicePid.LoopAlive(Path.Combine(dir, "service.pid"), probe));
            Assert.AreEqual(0, probed);
            Assert.IsTrue(ServicePid.LoopAlive(PidFile("777"), probe));
            Assert.AreEqual(777, probed);
        }

        [TestMethod]
        public void TheRealProbeSeesThisProcess()
        {
            using (var me = Process.GetCurrentProcess())
            {
                Assert.AreEqual(me.ProcessName, ServicePid.ProcessNameOf(me.Id));
            }
            Assert.IsNull(ServicePid.ProcessNameOf(int.MaxValue));
        }

        [TestMethod]
        public void TheRealProbeNeedsNoProcessHandle()
        {
            // Like the service loop (session 0, S4U), the System process (pid 4) refuses
            // OpenProcess to a normal user; its name must still come back.
            Assert.AreEqual("System", ServicePid.ProcessNameOf(4));
        }
    }
}
