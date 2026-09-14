import { defineConfig } from "vite";

// base: "./" — relative asset paths so the production build can be loaded
// from file:// inside Electron as well as served over http.
export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 8000,
  },
});
