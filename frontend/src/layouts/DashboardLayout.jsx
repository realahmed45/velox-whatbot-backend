import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { initSocket } from "@/services/socket";
import Sidebar from "@/components/layout/Sidebar";
import Header from "@/components/layout/Header";

export default function DashboardLayout() {
  const { user, activeWorkspace } = useAuthStore();
  const { fetchWorkspace, workspace } = useWorkspaceStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!activeWorkspace) {
      navigate("/onboarding");
      return;
    }
    fetchWorkspace(activeWorkspace);
    initSocket();
  }, [activeWorkspace]);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
