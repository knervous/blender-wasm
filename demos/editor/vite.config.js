import { fileURLToPath } from "node:url";
import { blenderWeb } from "@knervous/blender-web/vite";
import { defineConfig, searchForWorkspaceRoot } from "vite";

// The packages are linked from this repository (real paths outside this root).
const repo = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  // blenderWeb(): cross-origin isolation headers, the runtime served at
  // blender-runtime/ in dev and written into the build.
  plugins: [blenderWeb()],
  server: { port: 5321, fs: { allow: [searchForWorkspaceRoot(process.cwd()), repo] } },
  build: {
    target: "esnext",
    rollupOptions: { input: { index: "index.html", bench: "bench.html" } },
  },
});
