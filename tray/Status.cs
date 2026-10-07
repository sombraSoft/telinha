using System;
using System.Collections.Generic;
using System.Globalization;
using System.Web.Script.Serialization;

namespace Telinha.Tray
{
    /// <summary>
    /// GET /internal/status, read tolerantly: missing or mistyped fields fall back to
    /// defaults and unknown ones are ignored, so a newer service never breaks an older tray.
    /// </summary>
    public sealed class Status
    {
        public string Version = "";
        public long StartedAt;
        public int Pid;
        public string Ingress;
        public string Media;
        public int Rooms;
        /// <summary>name -> state, e.g. livekit -> up.</summary>
        public Dictionary<string, string> Children = new Dictionary<string, string>(StringComparer.Ordinal);
        public Dictionary<string, ChildStatus> ChildStatus = new Dictionary<string, ChildStatus>(StringComparer.Ordinal);
        /// <summary>null when the service has no updater (a dev run).</summary>
        public UpdateInfo Update;
        /// <summary>Running under `telinha service run`.</summary>
        public bool Supervised;
        public string PublicUrl;

        public static Status Parse(string json)
        {
            var d = Json.Object(json);
            return d == null ? null : From(d);
        }

        public static Status From(IDictionary<string, object> d)
        {
            var s = new Status
            {
                Version = Json.Str(d, "version") ?? "",
                StartedAt = Json.Long(d, "startedAt") ?? 0,
                Pid = (int)(Json.Long(d, "pid") ?? 0),
                Ingress = Json.Str(d, "ingress"),
                Media = Json.Str(d, "media"),
                Rooms = (int)(Json.Long(d, "rooms") ?? 0),
                Supervised = Json.Bool(d, "supervised") ?? false,
                PublicUrl = Json.Str(d, "publicUrl"),
            };
            var children = Json.Dict(d, "children");
            if (children != null)
            {
                foreach (var kv in children)
                {
                    var state = kv.Value as string;
                    if (state != null) s.Children[kv.Key] = state;
                }
            }
            var childStatus = Json.Dict(d, "childStatus");
            if (childStatus != null)
            {
                foreach (var kv in childStatus)
                {
                    var c = kv.Value as IDictionary<string, object>;
                    if (c == null) continue;
                    s.ChildStatus[kv.Key] = new ChildStatus
                    {
                        State = Json.Str(c, "state") ?? "",
                        Pid = (int?)Json.Long(c, "pid"),
                        Restarts = (int)(Json.Long(c, "restarts") ?? 0),
                        RecentRestarts = (int)(Json.Long(c, "recentRestarts") ?? 0),
                        Since = Json.Long(c, "since") ?? 0,
                    };
                }
            }
            var update = Json.Dict(d, "update");
            if (update != null) s.Update = UpdateInfo.From(update);
            return s;
        }
    }

    public sealed class ChildStatus
    {
        public string State = "";
        public int? Pid;
        public int Restarts;
        /// <summary>Respawn attempts in the server's 10 min window: the crash-loop signal.</summary>
        public int RecentRestarts;
        public long Since;
    }

    public sealed class UpdateInfo
    {
        public bool Enabled;
        public string Current;
        /// <summary>Newest stable tag at the last check.</summary>
        public string Latest;
        /// <summary>UPDATE_PIN; while set the service installs the pin, never latest.</summary>
        public string Pin;
        public string StagedTag;
        public string FailedTag;
        public string FailedReason;
        public string PendingTag;
        public long? DeferredSince;
        public long? LastCheck;
        /// <summary>The server sent an "applied" field (even null): an older one does not.</summary>
        public bool HasApplied;
        public UpdateApplied Applied;

        public static UpdateInfo From(IDictionary<string, object> u)
        {
            var info = new UpdateInfo
            {
                Enabled = Json.Bool(u, "enabled") ?? false,
                Current = Json.Str(u, "current"),
                Latest = Json.Str(u, "latest"),
                Pin = Json.Str(u, "pin"),
                DeferredSince = Json.Long(u, "deferredSince"),
                LastCheck = Json.Long(u, "lastCheck"),
                HasApplied = u.ContainsKey("applied"),
            };
            var staged = Json.Dict(u, "staged");
            if (staged != null) info.StagedTag = Json.Str(staged, "tag");
            var failed = Json.Dict(u, "failed");
            if (failed != null)
            {
                info.FailedTag = Json.Str(failed, "tag");
                info.FailedReason = Json.Str(failed, "reason");
            }
            var pending = Json.Dict(u, "pending");
            if (pending != null) info.PendingTag = Json.Str(pending, "tag");
            var applied = Json.Dict(u, "applied");
            if (applied != null && !string.IsNullOrEmpty(Json.Str(applied, "tag")))
            {
                info.Applied = new UpdateApplied
                {
                    Tag = Json.Str(applied, "tag"),
                    Previous = Json.Str(applied, "previous"),
                    At = Json.Long(applied, "at") ?? 0,
                };
            }
            return info;
        }
    }

    public sealed class UpdateApplied
    {
        public string Tag;
        public string Previous;
        public long At;
    }

    /// <summary>POST /internal/update's answer.</summary>
    public sealed class UpdateResult
    {
        /// <summary>none | staged | deferred | failed | pending</summary>
        public string Action = "none";
        public string Message = "";
        public string Current;
        public string Latest;
        public string Pin;
        /// <summary>The tag that would be installed now; null = up to date.</summary>
        public string Target;
        public string StagedTag;

        public static UpdateResult Parse(string json)
        {
            var d = Json.Object(json);
            if (d == null) return null;
            var staged = Json.Dict(d, "staged");
            return new UpdateResult
            {
                Action = Json.Str(d, "action") ?? "none",
                Message = Json.Str(d, "message") ?? "",
                Current = Json.Str(d, "current"),
                Latest = Json.Str(d, "latest"),
                Pin = Json.Str(d, "pin"),
                Target = Json.Str(d, "target"),
                StagedTag = staged == null ? null : Json.Str(staged, "tag"),
            };
        }
    }

    /// <summary>Tolerant readers over JavaScriptSerializer's dictionaries.</summary>
    public static class Json
    {
        public static IDictionary<string, object> Object(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            try
            {
                return new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }.DeserializeObject(json) as IDictionary<string, object>;
            }
            catch (ArgumentException)
            {
                return null;
            }
            catch (InvalidOperationException)
            {
                return null;
            }
        }

        public static string Serialize(object value)
        {
            return new JavaScriptSerializer().Serialize(value);
        }

        public static string Str(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v as string : null;
        }

        public static long? Long(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null || v is string || v is bool) return null;
            try
            {
                if (v is double || v is float || v is decimal)
                {
                    var x = Convert.ToDouble(v, CultureInfo.InvariantCulture);
                    if (double.IsNaN(x) || double.IsInfinity(x) || x > long.MaxValue || x < long.MinValue) return null;
                    return (long)Math.Floor(x);
                }
                return Convert.ToInt64(v, CultureInfo.InvariantCulture);
            }
            catch (Exception e) when (e is InvalidCastException || e is OverflowException || e is FormatException)
            {
                return null;
            }
        }

        public static bool? Bool(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v is bool ? (bool?)(bool)v : null;
        }

        public static IDictionary<string, object> Dict(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v as IDictionary<string, object> : null;
        }
    }
}
