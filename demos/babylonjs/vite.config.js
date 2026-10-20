import { defineConfig } from "vite";

/* Blender's pthreads need SharedArrayBuffer, which needs cross-origin isolation.
 * Static hosting of `vite build` output must send the same two headers. */
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: { port: 5321, headers: isolation },
  preview: { headers: isolation },
  build: { target: "esnext" },
});
