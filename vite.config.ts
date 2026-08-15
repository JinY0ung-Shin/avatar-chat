import fs from "node:fs";
import { createRequire } from "node:module";

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

const require = createRequire(import.meta.url);

// The composer mic's end-of-speech detector (Silero VAD) needs four runtime
// assets, and BOTH libraries address them by a base path + a HARD-CODED file
// name: @ricky0123/vad-web fetches `baseAssetPath + "silero_vad_legacy.onnx"`,
// onnxruntime-web fetches `env.wasm.wasmPaths + "ort-wasm-simd-threaded.wasm"`.
// A Vite `?url` import content-hashes the file name, so neither library could
// find the sibling it derives — hence a fixed `/vad/` path instead, copied out
// of node_modules (dev middleware + build emit). Same-origin is the point: the
// CSP ships `script-src 'self' 'wasm-unsafe-eval'` and no CDN source.
const VAD_ASSETS: Record<string, string> = {
  "vad.worklet.bundle.min.js": "@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
  "silero_vad_legacy.onnx": "@ricky0123/vad-web/dist/silero_vad_legacy.onnx",
  "ort-wasm-simd-threaded.mjs": "onnxruntime-web/ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm": "onnxruntime-web/ort-wasm-simd-threaded.wasm",
};

const VAD_ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

function vadAssets(): Plugin {
  const sourcePath = (name: string): string => require.resolve(VAD_ASSETS[name]);
  return {
    name: "noah-vad-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const requested = (req.url || "").split("?")[0];
        const name = requested.startsWith("/vad/") ? requested.slice("/vad/".length) : "";
        if (!Object.hasOwn(VAD_ASSETS, name)) {
          next();
          return;
        }
        res.setHeader("Content-Type", VAD_ASSET_TYPES[name.slice(name.lastIndexOf("."))]);
        fs.createReadStream(sourcePath(name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of Object.keys(VAD_ASSETS)) {
        this.emitFile({ type: "asset", fileName: `vad/${name}`, source: fs.readFileSync(sourcePath(name)) });
      }
    },
  };
}

export default defineConfig({
  root: "src/client",
  publicDir: "public",
  plugins: [svelte(), vadAssets()],
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
    // Mermaid is loaded only when a Mermaid canvas is opened. Its upstream
    // @mermaid-js/parser ships one pre-bundled 596 kB module (about 138 kB gzip),
    // which Rolldown cannot split further at module boundaries. Keep warnings
    // meaningful for every other chunk while allowing that verified lazy module.
    chunkSizeWarningLimit: 650,
  },
});
