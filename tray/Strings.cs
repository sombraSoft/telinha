using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Telinha.Tray
{
    /// <summary>
    /// Everything the tray says, in EN and pt-BR. Where telinha's CLI has the same line
    /// (service, update) the wording is the CLI's, so both say the same thing.
    /// </summary>
    public sealed class Strings
    {
        public const string En = "en";
        public const string PtBr = "pt-BR";

        public static readonly IReadOnlyDictionary<string, string> EnDict = new Dictionary<string, string>
        {
            { "statusRunning", "Telinha {version}: running" },
            { "statusRooms", "Telinha {version}: running, {n} room(s)" },
            { "statusStopped", "Telinha: not running" },
            { "statusNotAnswering", "Telinha: not answering" },
            { "statusStarting", "Telinha: starting…" },
            { "childDetail", "{name}: {state} ({n} restarts in 10 min)" },
            { "childState.starting", "starting" },
            { "childState.up", "up" },
            { "childState.restarting", "restarting" },
            { "childState.stopped", "stopped" },
            { "stagedDetail", "update to {tag} staged" },
            { "pinnedDetail", "pinned to {pin}" },
            { "failedDetail", "update to {tag} failed: {reason}" },
            { "pendingDetail", "{tag} is not downloadable yet" },
            { "deferredDetail", "the update waits for the open rooms to close" },
            { "open", "Open Telinha" },
            { "start", "Start" },
            { "stop", "Stop" },
            { "restart", "Restart" },
            { "checkUpdates", "Check for updates" },
            { "updateNow", "Update now" },
            { "updateNowTag", "Update now ({tag})" },
            { "openLog", "Open log" },
            { "autostart", "Start with Windows" },
            { "quit", "Quit" },
            { "checking", "Checking…" },
            { "updating", "Updating…" },
            { "notifyDown", "Telinha stopped." },
            { "notifyStuck", "Telinha has not come up in 5 minutes; check the log." },
            { "notifySelfLoop", "Telinha keeps restarting; check the log." },
            { "notifyChildLoop", "{name} keeps crashing; check the log." },
            { "notifyAvailable", "{tag} is available." },
            { "notifyApplied", "Updated to {tag}." },
            { "upToDate", "Up to date." },
            { "latestUnknown", "Newest stable release: unknown (offline, or none published)" },
            { "started", "Service started." },
            { "stopped", "Service stopped." },
            { "restarted", "Service restarted." },
            { "stoppedConsole", "Telinha stopped." },
            { "installedRestart", "{tag} installed; the service is restarting to apply it." },
            { "startFailed", "Could not start Telinha: {error}" },
            { "actionFailed", "{action} failed: {error}" },
            { "noExe", "telinha.exe is not next to the tray ({dir})." },
            { "timedOut", "no answer in {s} s" },
        };

        public static readonly IReadOnlyDictionary<string, string> PtBrDict = new Dictionary<string, string>
        {
            { "statusRunning", "Telinha {version}: rodando" },
            { "statusRooms", "Telinha {version}: rodando, {n} sala(s)" },
            { "statusStopped", "Telinha: parada" },
            { "statusNotAnswering", "Telinha: não responde" },
            { "statusStarting", "Telinha: iniciando…" },
            { "childDetail", "{name}: {state} ({n} reinícios em 10 min)" },
            { "childState.starting", "iniciando" },
            { "childState.up", "rodando" },
            { "childState.restarting", "reiniciando" },
            { "childState.stopped", "parado" },
            { "stagedDetail", "atualização pra {tag} preparada" },
            { "pinnedDetail", "fixada em {pin}" },
            { "failedDetail", "atualização pra {tag} falhou: {reason}" },
            { "pendingDetail", "{tag} ainda não pode ser baixada" },
            { "deferredDetail", "a atualização espera as salas abertas fecharem" },
            { "open", "Abrir Telinha" },
            { "start", "Iniciar" },
            { "stop", "Parar" },
            { "restart", "Reiniciar" },
            { "checkUpdates", "Verificar atualizações" },
            { "updateNow", "Atualizar agora" },
            { "updateNowTag", "Atualizar agora ({tag})" },
            { "openLog", "Abrir log" },
            { "autostart", "Iniciar com o Windows" },
            { "quit", "Sair" },
            { "checking", "Verificando…" },
            { "updating", "Atualizando…" },
            { "notifyDown", "A Telinha parou." },
            { "notifyStuck", "A Telinha não subiu em 5 minutos; veja o log." },
            { "notifySelfLoop", "A Telinha fica reiniciando; veja o log." },
            { "notifyChildLoop", "{name} fica caindo; veja o log." },
            { "notifyAvailable", "{tag} está disponível." },
            { "notifyApplied", "Atualizada pra {tag}." },
            { "upToDate", "Já está atualizada." },
            { "latestUnknown", "Versão estável mais nova: desconhecida (sem internet, ou nenhuma publicada)" },
            { "started", "Serviço iniciado." },
            { "stopped", "Serviço parado." },
            { "restarted", "Serviço reiniciado." },
            { "stoppedConsole", "A Telinha parou." },
            { "installedRestart", "{tag} instalada; o serviço está reiniciando pra aplicar." },
            { "startFailed", "Não deu pra iniciar a Telinha: {error}" },
            { "actionFailed", "{action} falhou: {error}" },
            { "noExe", "telinha.exe não está ao lado da bandeja ({dir})." },
            { "timedOut", "sem resposta em {s} s" },
        };

        private static readonly Regex Placeholder = new Regex(@"\{([A-Za-z0-9_]+)\}", RegexOptions.CultureInvariant);
        private static readonly Regex PosixDefault = new Regex(@"^(C|POSIX)([._@]|\z)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        public Strings(string locale)
        {
            Locale = locale == PtBr ? PtBr : En;
        }

        /// <summary>"en" or "pt-BR".</summary>
        public string Locale { get; }

        /// <summary>The line for <paramref name="key"/> with <c>{name}</c> placeholders filled from name/value pairs, in one pass.</summary>
        public string T(string key, params object[] pairs)
        {
            var dict = Locale == PtBr ? PtBrDict : EnDict;
            string template;
            if (!dict.TryGetValue(key, out template) && !EnDict.TryGetValue(key, out template)) template = key;
            return Fill(template, pairs);
        }

        /// <summary>The key exists (in the English dictionary, which has every key).</summary>
        public bool Has(string key)
        {
            return key != null && EnDict.ContainsKey(key);
        }

        public static string Fill(string template, params object[] pairs)
        {
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var i = 0; i + 1 < (pairs == null ? 0 : pairs.Length); i += 2)
            {
                values[Convert.ToString(pairs[i], CultureInfo.InvariantCulture)] = Convert.ToString(pairs[i + 1], CultureInfo.InvariantCulture);
            }
            // Unknown placeholders stay as written, like the CLI's fill().
            return Placeholder.Replace(template, m =>
            {
                string v;
                return values.TryGetValue(m.Groups[1].Value, out v) ? v : m.Value;
            });
        }

        /// <summary>Any tag (pt, pt_BR.UTF-8, en-US) to a supported locale: anything Portuguese is pt-BR.</summary>
        public static string LocaleFromTag(string tag)
        {
            if (string.IsNullOrEmpty(tag)) return En;
            return tag.Replace('_', '-').ToLowerInvariant().StartsWith("pt", StringComparison.Ordinal) ? PtBr : En;
        }

        /// <summary>
        /// LOCALE, else the first set of LC_ALL, LC_MESSAGES, LANG (C/POSIX count as
        /// unset), else the Windows display language: the CLI's pickLocale().
        /// </summary>
        public static string Pick(IDictionary<string, string> env, CultureInfo uiCulture)
        {
            var locale = Get(env, "LOCALE");
            if (!string.IsNullOrEmpty(locale)) return LocaleFromTag(locale);
            var posix = Get(env, "LC_ALL");
            if (string.IsNullOrEmpty(posix)) posix = Get(env, "LC_MESSAGES");
            if (string.IsNullOrEmpty(posix)) posix = Get(env, "LANG");
            if (!string.IsNullOrEmpty(posix) && !PosixDefault.IsMatch(posix)) return LocaleFromTag(posix);
            return LocaleFromTag(uiCulture == null ? null : uiCulture.Name);
        }

        private static string Get(IDictionary<string, string> env, string key)
        {
            string v;
            return env != null && env.TryGetValue(key, out v) ? v : null;
        }
    }
}
