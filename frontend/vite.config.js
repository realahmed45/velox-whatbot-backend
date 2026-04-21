import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "https://velox-whatbot-backend.onrender.com",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "https://velox-whatbot-backend.onrender.com",
        ws: true,
      },
    },
  },
});
