using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Telinha.Tray.Tests
{
    /// <summary>The order of compareVersions() in the server's updater.</summary>
    [TestClass]
    public class SemVerTests
    {
        private static void Less(string a, string b)
        {
            Assert.IsTrue(SemVer.Compare(a, b) < 0, a + " < " + b);
            Assert.IsTrue(SemVer.Compare(b, a) > 0, b + " > " + a);
        }

        [TestMethod]
        public void CoreNumbersCompareNumerically()
        {
            Less("0.7.0", "0.8.0");
            Less("0.9.0", "0.10.0");
            Less("1.2.3", "1.2.4");
            Less("0.99.99", "1.0.0");
        }

        [TestMethod]
        public void VPrefixIsIgnored()
        {
            Assert.AreEqual(0, SemVer.Compare("0.7.0", "v0.7.0"));
            Assert.AreEqual(0, SemVer.Compare("v0.7.0-rc.1", "0.7.0-rc.1"));
            Less("v0.7.0", "0.8.0");
        }

        [TestMethod]
        public void PrereleaseRanksBelowItsRelease()
        {
            Less("0.7.0-rc.1", "0.7.0");
            Less("0.6.9", "0.7.0-rc.1");
        }

        [TestMethod]
        public void PrereleaseIdentifiersCompareNumericallyThenOrdinal()
        {
            Less("0.7.0-rc.1", "0.7.0-rc.2");
            Less("0.7.0-rc.2", "0.7.0-rc.10");
            Assert.AreNotEqual(0, SemVer.Compare("0.7.0-rc.1", "0.7.0-rc.2"));
            Less("0.7.0-alpha", "0.7.0-beta");
            Less("0.7.0-beta.2", "0.7.0-rc.1");
            // Fewer identifiers rank lower.
            Less("0.7.0-rc", "0.7.0-rc.1");
            // Numeric against text: ordinal, as JavaScript's < on strings.
            Less("0.7.0-1", "0.7.0-rc");
        }

        [TestMethod]
        public void MissingCorePositionsAreZero()
        {
            Assert.AreEqual(0, SemVer.Compare("1", "1.0.0"));
            Assert.AreEqual(0, SemVer.Compare("1.2", "1.2.0"));
            Less("1.2", "1.2.1");
            Assert.AreEqual(0, SemVer.Compare("", "0.0.0"));
            // Number(x) || 0: a non-numeric position counts as 0.
            Assert.AreEqual(0, SemVer.Compare("1.x.0", "1.0.0"));
        }

        [TestMethod]
        public void JavaScriptNumberSpellings()
        {
            Assert.AreEqual(0d, SemVer.JsNumber(""));
            Assert.AreEqual(16d, SemVer.JsNumber("0x10"));
            Assert.AreEqual(100d, SemVer.JsNumber("1e2"));
            Assert.AreEqual(5d, SemVer.JsNumber(" 5 "));
            Assert.IsTrue(double.IsNaN(SemVer.JsNumber("1a")));
            Assert.IsTrue(double.IsNaN(SemVer.JsNumber("-0x10")));
            Assert.IsTrue(double.IsPositiveInfinity(SemVer.JsNumber("Infinity")));
        }
    }
}
