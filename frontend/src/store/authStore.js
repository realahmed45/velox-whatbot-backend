import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useAuthStore = create(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      refreshToken: null,
      activeWorkspace: null, // workspaceId string

      setUser: (user) => set({ user }),
      setTokens: (token, refreshToken) => set({ token, refreshToken }),
      setActiveWorkspace: (workspaceId) =>
        set({ activeWorkspace: workspaceId }),

      login: (user, token, refreshToken) => {
        const ws = user?.activeWorkspace || user?.workspaces?.[0];
        set({
          user,
          token,
          refreshToken,
          activeWorkspace: ws?._id || ws || null,
        });
      },

      logout: () =>
        set({
          user: null,
          token: null,
          refreshToken: null,
          activeWorkspace: null,
        }),
    }),
    {
      name: "velox-auth",
      partialize: (state) => ({
        token: state.token,
        refreshToken: state.refreshToken,
        user: state.user,
        activeWorkspace: state.activeWorkspace,
      }),
    },
  ),
);
