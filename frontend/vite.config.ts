import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BACKEND_PROXY_TARGET is a server-side variable used only by the Vite dev server
// to forward /api requests. It is never injected into the browser bundle.
// Local default: http://localhost:3001
// Docker: http://backend:3001 (set via Docker Compose environment)
const backendTarget = process.env.BACKEND_PROXY_TARGET ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
