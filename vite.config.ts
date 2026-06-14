import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/client",
  publicDir: "public",
  plugins: [svelte()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": "http://localhost:48787",
      "/users": "http://localhost:48787",
      "/fonts": "http://localhost:48787",
    },
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
