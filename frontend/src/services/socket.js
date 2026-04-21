import { io } from "socket.io-client";
import { useAuthStore } from "@/store/authStore";

let socket = null;

export const initSocket = () => {
  if (socket?.connected) return socket;

  const token = useAuthStore.getState().token;

  socket = io(
    import.meta.env.VITE_SOCKET_URL || "https://flowgram-backend.onrender.com",
    {
      auth: { token },
      transports: ["websocket"],
      reconnectionAttempts: 5,
    },
  );

  socket.on("connect", () => console.log("[Socket] Connected:", socket.id));
  socket.on("disconnect", (reason) =>
    console.log("[Socket] Disconnected:", reason),
  );
  socket.on("connect_error", (err) =>
    console.error("[Socket] Error:", err.message),
  );

  return socket;
};

export const getSocket = () => socket;

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};
