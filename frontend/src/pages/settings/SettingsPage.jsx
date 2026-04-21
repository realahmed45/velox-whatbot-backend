import { useEffect, useState } from "react";
import api from "@/services/api";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useAuthStore } from "@/store/authStore";
import toast from "react-hot-toast";
import {
  Save,
  RefreshCw,
  ExternalLink,
  Globe,
  Clock,
  Users,
  Instagram,
  AlertCircle,
  Loader2,
  CheckCircle2,
  Trash2,
} from "lucide-react";

export default function SettingsPage() {
  const { workspace, fetchWorkspace } = useWorkspaceStore();
  const { activeWorkspace } = useAuthStore();
  const [tab, setTab] = useState("general");

  const TABS = [
    { id: "general", label: "General" },
    { id: "instagram", label: "Instagram" },
    { id: "automation", label: "Automation" },
    { id: "team", label: "Team" },
  ];

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-bold text-gray-900 mb-6">Settings</h1>
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-6 w-fit">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${tab === t.id ? "bg-white text-gray-800 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <GeneralSettings
          workspace={workspace}
          onSave={() => fetchWorkspace(activeWorkspace)}
        />
      )}
      {tab === "instagram" && (
        <InstagramSettings
          workspace={workspace}
          onSave={() => fetchWorkspace(activeWorkspace)}
        />
      )}
      {tab === "automation" && (
        <AutomationSettings
          workspace={workspace}
          onSave={() => fetchWorkspace(activeWorkspace)}
        />
      )}
      {tab === "team" && <TeamSettings workspace={workspace} />}
    </div>
  );
}

function GeneralSettings({ workspace, onSave }) {
  const [form, setForm] = useState({
    name: workspace?.name || "",
    timezone: workspace?.timezone || "Asia/Karachi",
    welcomeMessage: workspace?.settings?.welcomeMessage || "",
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (workspace)
      setForm({
        name: workspace.name,
        timezone: workspace.timezone || "Asia/Karachi",
        welcomeMessage: workspace.settings?.welcomeMessage || "",
      });
  }, [workspace]);

  const save = async () => {
    setLoading(true);
    try {
      await api.put(`/workspaces/${workspace._id}`, {
        name: form.name,
        timezone: form.timezone,
        settings: { welcomeMessage: form.welcomeMessage },
      });
      toast.success("Settings saved");
      onSave();
    } catch (err) {
      toast.error("Failed to save");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card p-6 space-y-4">
      <div>
        <label className="label">Workspace name</label>
        <input
          className="input"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </div>
      <div>
        <label className="label">Timezone</label>
        <select
          className="input"
          value={form.timezone}
          onChange={(e) => setForm({ ...form, timezone: e.target.value })}
        >
          <option value="Asia/Karachi">Asia/Karachi (PKT +5)</option>
          <option value="Asia/Dubai">Asia/Dubai (GST +4)</option>
          <option value="UTC">UTC</option>
          <option value="America/New_York">America/New_York (ET)</option>
        </select>
      </div>
      <div>
        <label className="label">Welcome message (sent to new contacts)</label>
        <textarea
          className="input resize-none"
          rows={3}
          value={form.welcomeMessage}
          onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })}
          placeholder="Hi {{name}}! Welcome, we're glad you're here 👋"
        />
      </div>
      <button onClick={save} disabled={loading} className="btn-primary gap-2">
        <Save className="w-4 h-4" />
        {loading ? "Saving…" : "Save changes"}
      </button>
    </div>
  );
}

function InstagramSettings({ workspace, onSave }) {
  const ig = workspace?.instagram;
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [cookie, setCookie] = useState("");
  const [cookieMode, setCookieMode] = useState(false);

  const startOAuth = async () => {
    setOauthLoading(true);
    try {
      const { data } = await api.get("/instagram/connect/oauth-url");
      window.location.href = data.url;
    } catch (err) {
      toast.error(err.response?.data?.message || "OAuth failed");
      setOauthLoading(false);
    }
  };

  const saveSessionCookie = async () => {
    if (!cookie.trim()) return toast.error("Cookie required");
    setLoading(true);
    try {
      await api.post("/instagram/connect/session", {
        sessionCookie: cookie.trim(),
      });
      toast.success("Session cookie saved");
      onSave();
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed");
    } finally {
      setLoading(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Instagram? Automations will stop.")) return;
    try {
      await api.delete("/instagram/connect");
      toast.success("Disconnected");
      onSave();
    } catch {
      toast.error("Failed to disconnect");
    }
  };

  return (
    <div className="card p-6 space-y-5">
      {/* Connection status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {ig?.profilePicture ? (
            <img
              src={ig.profilePicture}
              className="w-10 h-10 rounded-full border border-pink-200"
              alt=""
            />
          ) : (
            <div className="w-10 h-10 bg-pink-50 rounded-full flex items-center justify-center">
              <Instagram className="w-5 h-5 text-pink-500" />
            </div>
          )}
          <div>
            <p className="font-semibold text-sm text-gray-900">
              {ig?.status === "connected" ? `@${ig.username}` : "Not connected"}
            </p>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                ig?.status === "connected"
                  ? "bg-green-100 text-green-700"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {ig?.status === "connected"
                ? `â— Connected Â· ${ig?.connectionType === "meta_oauth" ? "Meta OAuth" : "Session Cookie"}`
                : "â— Disconnected"}
            </span>
          </div>
        </div>
        {ig?.status === "connected" && (
          <button
            onClick={disconnect}
            className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 px-3 py-1.5 rounded-lg transition"
          >
            <Trash2 className="w-3 h-3" />
            Disconnect
          </button>
        )}
      </div>

      {ig?.status !== "connected" && (
        <>
          {/* Method tabs */}
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {[
              { id: false, label: "Meta OAuth (Recommended)" },
              { id: true, label: "Session Cookie" },
            ].map((opt) => (
              <button
                key={String(opt.id)}
                onClick={() => setCookieMode(opt.id)}
                className={`flex-1 py-2 text-xs font-medium transition ${
                  cookieMode === opt.id
                    ? "bg-pink-500 text-white"
                    : "text-gray-500 hover:bg-gray-50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {!cookieMode ? (
            <div>
              <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-700 mb-4">
                <p className="font-medium mb-1">Requirements:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Instagram Business or Creator account</li>
                  <li>Facebook Page linked to your Instagram</li>
                  <li>Admin access to that Facebook Page</li>
                </ul>
              </div>
              <button
                onClick={startOAuth}
                disabled={oauthLoading}
                className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-pink-500 to-purple-600 text-white font-semibold py-3 rounded-xl hover:opacity-90 transition disabled:opacity-60"
              >
                {oauthLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Instagram className="w-4 h-4" />
                )}
                Connect with Instagram
                <ExternalLink className="w-3 h-3 opacity-70" />
              </button>
            </div>
          ) : (
            <div>
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex gap-2 mb-4">
                <AlertCircle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-yellow-700">
                  Session cookies bypass the official API. Use only on accounts
                  you own.
                </p>
              </div>
              <label className="label">Instagram sessionid Cookie</label>
              <textarea
                className="input min-h-[72px] text-xs font-mono mb-3"
                placeholder="Paste sessionid value…"
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
              />
              <button
                onClick={saveSessionCookie}
                disabled={loading}
                className="btn-primary gap-2"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save session cookie
              </button>
            </div>
          )}
        </>
      )}

      {ig?.status === "connected" && (
        <div className="bg-gray-50 rounded-lg p-4">
          <p className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-2">
            Webhook URL
          </p>
          <code className="text-xs text-gray-700 break-all">
            {import.meta.env.VITE_API_URL ||
              "https://flowgram-backend.onrender.com/api"}
            /instagram/webhook
          </code>
          <p className="text-xs text-gray-400 mt-2">
            Set this URL in your Meta App dashboard under Instagram → Webhooks.
          </p>
        </div>
      )}
    </div>
  );
}

function AutomationSettings({ workspace, onSave }) {
  const [form, setForm] = useState({
    automationEnabled: workspace?.settings?.automationEnabled ?? true,
    minDelayMinutes: workspace?.settings?.minDelayMinutes ?? 1,
    maxDelayMinutes: workspace?.settings?.maxDelayMinutes ?? 5,
    activeHourStart: workspace?.settings?.activeHourStart ?? 8,
    activeHourEnd: workspace?.settings?.activeHourEnd ?? 22,
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (workspace?.settings)
      setForm({
        automationEnabled: workspace.settings.automationEnabled ?? true,
        minDelayMinutes: workspace.settings.minDelayMinutes ?? 1,
        maxDelayMinutes: workspace.settings.maxDelayMinutes ?? 5,
        activeHourStart: workspace.settings.activeHourStart ?? 8,
        activeHourEnd: workspace.settings.activeHourEnd ?? 22,
      });
  }, [workspace]);

  const save = async () => {
    setLoading(true);
    try {
      await api.put("/instagram/settings", form);
      toast.success("Automation settings saved");
      onSave();
    } catch (err) {
      toast.error("Failed to save");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card p-6 space-y-5">
      {/* Master toggle */}
      <div className="flex items-center justify-between py-2">
        <div>
          <p className="font-medium text-gray-800 text-sm">Enable Automation</p>
          <p className="text-xs text-gray-500">
            Turn all DM automations on or off globally
          </p>
        </div>
        <button
          onClick={() =>
            setForm((f) => ({ ...f, automationEnabled: !f.automationEnabled }))
          }
          className={`relative w-11 h-6 rounded-full transition-colors ${
            form.automationEnabled ? "bg-brand-600" : "bg-gray-300"
          }`}
        >
          <span
            className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
              form.automationEnabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {/* Delay range */}
      <div>
        <label className="label">Reply delay range (minutes)</label>
        <p className="text-xs text-gray-400 mb-3">
          Random delay before sending automated DMs (avoids spam detection)
        </p>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="text-xs text-gray-500">Min</label>
            <input
              type="number"
              min={0}
              max={60}
              className="input"
              value={form.minDelayMinutes}
              onChange={(e) =>
                setForm({ ...form, minDelayMinutes: +e.target.value })
              }
            />
          </div>
          <span className="text-gray-400 mt-5">â€”</span>
          <div className="flex-1">
            <label className="text-xs text-gray-500">Max</label>
            <input
              type="number"
              min={0}
              max={120}
              className="input"
              value={form.maxDelayMinutes}
              onChange={(e) =>
                setForm({ ...form, maxDelayMinutes: +e.target.value })
              }
            />
          </div>
        </div>
      </div>

      {/* Active hours */}
      <div>
        <label className="label">Active hours</label>
        <p className="text-xs text-gray-400 mb-3">
          Only send automated DMs within this window
        </p>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <label className="text-xs text-gray-500">From (hour 0–23)</label>
            <input
              type="number"
              min={0}
              max={23}
              className="input"
              value={form.activeHourStart}
              onChange={(e) =>
                setForm({ ...form, activeHourStart: +e.target.value })
              }
            />
          </div>
          <span className="text-gray-400 mt-5">â€”</span>
          <div className="flex-1">
            <label className="text-xs text-gray-500">To (hour 0–23)</label>
            <input
              type="number"
              min={0}
              max={23}
              className="input"
              value={form.activeHourEnd}
              onChange={(e) =>
                setForm({ ...form, activeHourEnd: +e.target.value })
              }
            />
          </div>
        </div>
      </div>

      <button onClick={save} disabled={loading} className="btn-primary gap-2">
        <Save className="w-4 h-4" />
        {loading ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}

function TeamSettings({ workspace }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  const inviteAgent = async () => {
    if (!email) {
      toast.error("Email required");
      return;
    }
    setLoading(true);
    try {
      await api.post(`/workspaces/${workspace?._id}/invite`, {
        email,
        role: "agent",
      });
      toast.success("Invite sent!");
      setEmail("");
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to invite");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card p-6 space-y-4">
      <p className="font-semibold text-gray-800">Team Members</p>
      <div className="space-y-2">
        {workspace?.members?.map((m) => (
          <div
            key={m.user?._id || m.user}
            className="flex items-center gap-3 p-3 rounded-lg bg-gray-50"
          >
            <div className="w-8 h-8 bg-brand-100 rounded-full flex items-center justify-center text-brand-700 text-xs font-semibold">
              {m.user?.name?.[0]?.toUpperCase() || "?"}
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-800">
                {m.user?.name || m.user?.email || "Member"}
              </p>
              <p className="text-xs text-gray-400 capitalize">{m.role}</p>
            </div>
          </div>
        ))}
        {(!workspace?.members || workspace.members.length === 0) && (
          <p className="text-sm text-gray-400">No team members yet.</p>
        )}
      </div>
      <div className="border-t border-gray-100 pt-4">
        <p className="font-medium text-sm text-gray-700 mb-3">
          Invite a team member
        </p>
        <div className="flex gap-2">
          <input
            className="input flex-1"
            type="email"
            placeholder="colleague@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button
            onClick={inviteAgent}
            disabled={loading}
            className="btn-primary"
          >
            {loading ? "…" : "Invite"}
          </button>
        </div>
      </div>
    </div>
  );
}
