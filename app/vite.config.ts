import { defineConfig } from "vite";

// Tauri expects a fixed port and no screen clearing.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", minify: "esbuild", sourcemap: false, cssMinify: true, reportCompressedSize: false },
  test: { environment: "jsdom", include: ["src/**/*.test.ts"] },
} as any);
