import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 8642,
    strictPort: true,
    allowedHosts: ["voice.marchildon.net"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8643",
        changeOrigin: true
      }
    }
  }
});
