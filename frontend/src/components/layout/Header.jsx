import { Bell } from "lucide-react";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useAuthStore } from "@/store/authStore";

export default function Header() {
  const { workspace } = useWorkspaceStore();
  const { user } = useAuthStore();

  const usagePct = workspace
    ? Math.round(
        (workspace.usage?.messagesThisMonth /
          (workspace.usage?.messagesLimit || 1)) *
          100,
      )
    : 0;

  return (
    <header className="h-16 bg-white border-b border-gray-100 flex items-center justify-between px-6 flex-shrink-0">
      <div />
      <div className="flex items-center gap-4">
        {/* Usage pill */}
        {workspace && (
          <div className="hidden sm:flex items-center gap-2 text-xs text-gray-500">
            <span>Messages:</span>
            <div className="w-24 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${usagePct > 90 ? "bg-red-500" : usagePct > 70 ? "bg-yellow-400" : "bg-brand-500"}`}
                style={{ width: `${Math.min(usagePct, 100)}%` }}
              />
            </div>
            <span className="font-medium text-gray-700">{usagePct}%</span>
          </div>
        )}
        <button className="relative p-2 rounded-lg text-gray-500 hover:bg-gray-50">
          <Bell className="w-5 h-5" />
        </button>
        <div className="w-8 h-8 bg-brand-100 rounded-full flex items-center justify-center text-brand-700 font-semibold text-sm">
          {user?.name?.[0]?.toUpperCase() || "U"}
        </div>
      </div>
    </header>
  );
}
