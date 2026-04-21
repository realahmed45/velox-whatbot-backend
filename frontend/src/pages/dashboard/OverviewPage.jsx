import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import {
  Instagram,
  Zap,
  MessageSquare,
  Users,
  TrendingUp,
  Settings,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

export default function OverviewPage() {
  const { activeWorkspace } = useAuthStore();
  const { workspace } = useWorkspaceStore();
  const [stats, setStats] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!activeWorkspace) return;
    api.get("/analytics/overview")
      .then(({ data }) => setStats(data))
      .catch(() => {});
  }, [activeWorkspace]);

  const isConnected = workspace?.instagram?.status === "connected";

  const startOAuth = async () => {
    try {
      const { data } = await api.get("/instagram/connect/oauth-url");
      window.location.href = data.url;
    } catch {
      // handled by api interceptor
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome{workspace?.name ? `, ${workspace.name}` : ""}! 👋
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Your Instagram DM automation dashboard
        </p>
      </div>

      {/* Instagram connection status */}
      <div className={`rounded-2xl p-5 mb-6 border-2 ${isConnected ? "border-green-200 bg-green-50" : "border-pink-200 bg-pink-50"}`}>
        <div className="flex items-center gap-3 mb-3">
          {isConnected ? (
            <CheckCircle2 className="w-6 h-6 text-green-500" />
          ) : (
            <AlertCircle className="w-6 h-6 text-pink-500" />
          )}
          <div>
            <p className="font-semibold text-gray-900">
              {isConnected
                ? `@${workspace.instagram.username} connected`
                : "Instagram not connected"}
            </p>
            <p className="text-xs text-gray-500">
              {isConnected
                ? "Automation is active"
                : "Connect to start automating DMs"}
            </p>
          </div>
        </div>
        {!isConnected && (
          <button
            onClick={startOAuth}
            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-pink-500 to-purple-600 text-white font-semibold py-3 rounded-xl hover:opacity-90 transition"
          >
            <Instagram className="w-4 h-4" />
            Connect Instagram Business Account
          </button>
        )}
      </div>

      {/* Main actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <button
          onClick={() => navigate("/dashboard/automation")}
          className="group p-5 rounded-2xl border-2 border-purple-200 bg-purple-50 hover:border-purple-400 hover:bg-purple-100 transition text-left"
        >
          <div className="w-10 h-10 bg-purple-600 rounded-xl flex items-center justify-center mb-3">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <p className="font-bold text-gray-900">Setup Automation</p>
          <p className="text-xs text-gray-500 mt-1">
            Edit greeting & follow-up messages
          </p>
        </button>

        <button
          onClick={() => navigate("/dashboard/analytics")}
          className="group p-5 rounded-2xl border-2 border-blue-200 bg-blue-50 hover:border-blue-400 hover:bg-blue-100 transition text-left"
        >
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center mb-3">
            <TrendingUp className="w-5 h-5 text-white" />
          </div>
          <p className="font-bold text-gray-900">Analytics</p>
          <p className="text-xs text-gray-500 mt-1">
            Track DMs sent, replies, and growth
          </p>
        </button>
      </div>

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "DMs Sent", value: stats.totalMessages ?? 0, icon: MessageSquare, color: "text-blue-600" },
            { label: "Contacts", value: stats.totalContacts ?? 0, icon: Users, color: "text-purple-600" },
            { label: "Reply Rate", value: stats.replyRate ? `${stats.replyRate}%` : "—", icon: TrendingUp, color: "text-green-600" },
          ].map(({ label, value, icon: Icon, color }) => (
            <div key={label} className="bg-white rounded-xl border border-gray-100 p-4 text-center">
              <Icon className={`w-5 h-5 mx-auto mb-1 ${color}`} />
              <p className="text-xl font-bold text-gray-900">{value}</p>
              <p className="text-xs text-gray-400">{label}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OverviewPage() {
  const { activeWorkspace } = useAuthStore();
  const { workspace } = useWorkspaceStore();
  const [stats, setStats] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    if (!activeWorkspace) return;
    const load = async () => {
      try {
        const [overviewRes, chartRes] = await Promise.all([
          api.get("/analytics/overview"),
          api.get("/analytics/messages-over-time?period=week"),
        ]);
        setStats(overviewRes.data);
        setChartData(chartRes.data.data || []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [activeWorkspace]);

  const CARDS = [
    {
      label: "DMs Sent",
      value: stats?.totalMessages ?? "—",
      icon: MessageSquare,
      color: "text-blue-600 bg-blue-50",
    },
    {
      label: "Followers Reached",
      value: stats?.totalContacts ?? "—",
      icon: Users,
      color: "text-purple-600 bg-purple-50",
    },
    {
      label: "Active Flows",
      value: stats?.activeFlows ?? "—",
      icon: GitBranch,
      color: "text-brand-600 bg-brand-50",
    },
    {
      label: "Automation Rate",
      value: stats?.botHandledPct ? `${stats.botHandledPct}%` : "—",
      icon: Bot,
      color: "text-orange-600 bg-orange-50",
    },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Instagram status banner */}
      {workspace && workspace.instagram?.status !== "connected" && (
        <div className="bg-gradient-to-r from-pink-50 to-purple-50 border border-pink-200 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Instagram className="w-5 h-5 text-pink-500" />
            <div>
              <p className="font-medium text-pink-800 text-sm">
                Instagram not connected
              </p>
              <p className="text-pink-600 text-xs mt-0.5">
                Connect your Instagram account to start automating DMs.
              </p>
            </div>
          </div>
          <button
            onClick={() => navigate("/dashboard/settings")}
            className="flex items-center gap-1.5 text-sm font-medium text-pink-700 border border-pink-300 hover:bg-pink-100 px-3 py-1.5 rounded-lg transition"
          >
            Connect now <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      )}

      <div>
        <h1 className="text-xl font-bold text-gray-900">Overview</h1>
        <p className="text-gray-500 text-sm">
          {dayjs().format("dddd, MMMM D")}
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {CARDS.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card p-5">
            <div
              className={`w-9 h-9 rounded-lg flex items-center justify-center ${color} mb-3`}
            >
              <Icon className="w-4 h-4" />
            </div>
            <p className="text-2xl font-bold text-gray-900">
              {loading ? "…" : value}
            </p>
            <p className="text-sm text-gray-500 mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="card p-5">
        <h2 className="font-semibold text-gray-800 mb-4">DMs sent this week</h2>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="msgGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#16a34a" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11 }}
                tickFormatter={(d) => dayjs(d).format("ddd")}
              />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area
                type="monotone"
                dataKey="count"
                stroke="#16a34a"
                fill="url(#msgGradient)"
                strokeWidth={2}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[200px] flex items-center justify-center text-gray-400 text-sm">
            {loading ? "Loading chart…" : "No data yet — start automating!"}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="font-semibold text-gray-800 mb-3">Quick actions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            {
              label: "Build an automation flow",
              desc: "Automate DMs for new followers, keywords & more",
              to: "/dashboard/flows",
              icon: GitBranch,
            },
            {
              label: "View DM Inbox",
              desc: "Read and reply to conversations",
              to: "/dashboard/inbox",
              icon: MessageSquare,
            },
            {
              label: "Manage contacts",
              desc: "View followers & captured leads",
              to: "/dashboard/contacts",
              icon: Users,
            },
          ].map(({ label, desc, to, icon: Icon }) => (
            <button
              key={label}
              onClick={() => navigate(to)}
              className="card p-4 text-left hover:shadow-md transition-shadow flex items-start gap-3"
            >
              <div className="w-8 h-8 bg-gray-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <Icon className="w-4 h-4 text-gray-600" />
              </div>
              <div>
                <p className="font-medium text-sm text-gray-800">{label}</p>
                <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
