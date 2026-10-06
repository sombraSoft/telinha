using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Telinha.Tray.Tests
{
    [TestClass]
    public class AutostartTests
    {
        private const string Exe = @"C:\Users\ana\AppData\Local\Telinha\bin\telinha-tray.exe";

        private sealed class FakeValue : IRegistryValue
        {
            public string Data;
            public int Deletes;

            public string Get()
            {
                return Data;
            }

            public void Set(string value)
            {
                Data = value;
            }

            public void Delete()
            {
                Data = null;
                Deletes++;
            }
        }

        [TestMethod]
        public void RendersTheQuotedFullPath()
        {
            Assert.AreEqual("\"" + Exe + "\"", Autostart.Render(Exe));
            Assert.AreEqual(@"""C:\Program Files\Telinha\bin\telinha-tray.exe""", Autostart.Render(@"C:\Program Files\Telinha\bin\telinha-tray.exe"));
        }

        [TestMethod]
        public void ParsesWhatARunValueStarts()
        {
            Assert.AreEqual(Exe, Autostart.Parse(Autostart.Render(Exe)));
            Assert.AreEqual(@"C:\Program Files\x.exe", Autostart.Parse(@"""C:\Program Files\x.exe"" --flag"));
            Assert.AreEqual(@"C:\x\tray.exe", Autostart.Parse(@"C:\x\tray.exe --relaunched"));
            Assert.IsNull(Autostart.Parse(""));
            Assert.IsNull(Autostart.Parse(null));
            Assert.IsNull(Autostart.Parse("\"\""));
        }

        [TestMethod]
        public void OnWritesTheValueOffDeletesIt()
        {
            var v = new FakeValue();
            var a = new Autostart(v, Exe);
            Assert.IsFalse(a.IsEnabled());
            a.Set(true);
            Assert.AreEqual("\"" + Exe + "\"", v.Data);
            Assert.IsTrue(a.IsEnabled());
            a.Set(false);
            Assert.IsNull(v.Data);
            Assert.AreEqual(1, v.Deletes);
            Assert.IsFalse(a.IsEnabled());
        }

        [TestMethod]
        public void EnabledOnlyForThisExeIgnoringCase()
        {
            var v = new FakeValue { Data = "\"" + Exe.ToUpperInvariant() + "\"" };
            Assert.IsTrue(new Autostart(v, Exe).IsEnabled());
            v.Data = Exe;
            Assert.IsTrue(new Autostart(v, Exe).IsEnabled());
            v.Data = @"""D:\elsewhere\bin\telinha-tray.exe""";
            Assert.IsFalse(new Autostart(v, Exe).IsEnabled());
        }
    }
}
