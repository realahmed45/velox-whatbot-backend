import axios from "axios";
import { useAuthStore } from "@/store/authStore";

const api = axios.create({
  baseURL:
    import.meta.env.VITE_API_URL || "https://flowgram-backend.onrender.com/api",
  headers: { "Content-Type": "application/json" },
});

// Attach token + workspace id to every request
api.interceptors.request.use((config) => {
  const { token, activeWorkspace } = useAuthStore.getState();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (activeWorkspace) config.headers["x-workspace-id"] = activeWorkspace;
  console.log(
    `[API] --> ${config.method?.toUpperCase()} ${config.baseURL || ""}${config.url}`,
    {
      headers: {
        ...config.headers,
        Authorization: config.headers.Authorization ? "Bearer ***" : undefined,
      },
      data: config.data,
    },
  );
  return config;
});

// Handle 401 — clear auth and redirect to login
api.interceptors.response.use(
  (res) => {
    console.log(`[API] <-- ${res.status} ${res.config?.url}`, res.data);
    return res;
  },
  async (err) => {
    const originalRequest = err.config;
    console.error(
      `[API] <-- ERROR ${err.response?.status ?? "(no response)"} ${originalRequest?.url}`,
      {
        data: err.response?.data,
        message: err.message,
      },
    );
    if (err.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      console.warn("[API] 401 received — attempting token refresh...");
      try {
        const refreshToken = useAuthStore.getState().refreshToken;
        const { data } = await axios.post("/api/auth/refresh", {
          refreshToken,
        });
        useAuthStore.getState().setTokens(data.token, data.refreshToken);
        originalRequest.headers.Authorization = `Bearer ${data.token}`;
        console.log("[API] Token refreshed, retrying original request");
        return api(originalRequest);
      } catch (refreshErr) {
        console.error("[API] Token refresh failed — logging out", refreshErr);
        useAuthStore.getState().logout();
        window.location.href = "/login";
      }
    }
    return Promise.reject(err);
  },
);

export default api;
