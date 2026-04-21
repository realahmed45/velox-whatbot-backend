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
