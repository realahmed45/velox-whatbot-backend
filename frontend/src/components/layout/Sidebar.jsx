import { NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Zap,
  BarChart2,
  Settings,
  LogOut,
  Instagram,
} from "lucide-react";
import { useAuthStore } from "@/store/authStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { clsx } from "clsx";

const NAV = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard", end: true },
  { to: "/dashboard/automation", icon: Zap, label: "Automation" },
  { to: "/dashboard/analytics", icon: BarChart2, label: "Analytics" },
  { to: "/dashboard/settings", icon: Settings, label: "Settings" },
];

export default function Sidebar() {
  const { logout, user } = useAuthStore();
  const { workspace } = useWorkspaceStore();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  return (
    <aside className="w-56 flex-shrink-0 bg-white border-r border-gray-100 flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center gap-2 px-4 border-b border-gray-100">
        <div className="w-8 h-8 bg-gradient-to-br from-pink-500 to-purple-600 rounded-lg flex items-center justify-center">
          <Instagram className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-gray-900">Botlify</span>
      </div>

      {/* Instagram status badge */}
      {workspace && (
        <div className="px-4 py-3 border-b border-gray-50">
          <p className="text-xs text-gray-400 truncate font-medium">{workspace.name}</p>
          <span
            className={clsx(
              "inline-flex items-center gap-1 text-xs mt-1 font-medium",
              workspace.instagram?.status === "connected"
                ? "text-green-600"
                : "text-gray-400",
            )}
          >
            <span className={clsx("w-1.5 h-1.5 rounded-full", workspace.instagram?.status === "connected" ? "bg-green-500" : "bg-gray-300")} />
            {workspace.instagram?.status === "connected" ? "Connected" : "Not connected"}
          </span>
        </div>
      )}

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {NAV.map(({ to, icon: Icon, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              clsx(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium mb-0.5 transition-colors",
                isActive
                  ? "bg-purple-50 text-purple-700"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900",
              )
            }
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User + Logout */}
      <div className="p-3 border-t border-gray-100">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center text-purple-700 font-semibold text-xs">
            {user?.name?.[0]?.toUpperCase() || "U"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-800 truncate">
              {user?.name}
            </p>
            <p className="text-xs text-gray-400 truncate">{user?.email}</p>
          </div>
          <button
            onClick={handleLogout}
            className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition"
            title="Logout"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
