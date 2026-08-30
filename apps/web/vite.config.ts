import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative assets keep one production build valid at both / and reverse-proxy subpaths.
  base: process.env.YURUPAGER_WEB_BASE ?? "./",
  plugins: [react()],
  server: {
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4300", changeOrigin: true, ws: true },
      "/connector": { target: "ws://127.0.0.1:4300", changeOrigin: true, ws: true },
    },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
