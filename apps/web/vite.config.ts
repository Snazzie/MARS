import { spawn, type ChildProcess } from "node:child_process";
import { resolve, sep } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { defineConfig, type Plugin } from "vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";

const devEntry: Plugin = {
  name: "mars-dev-entry",
  transformIndexHtml: {
    order: "pre",
    handler(html) {
      return html.replace('src="/index.js"', 'src="/src/index.tsx"');
    },
  },
};

// The control plane (including the dev tunnel) serves dist, not Vite's HMR assets.
const rebuildServedUi: Plugin = {
  name: "mars-rebuild-served-ui",
  apply: "serve",
  configureServer(server) {
    const root = server.config.root;
    const directories = ["src", "public", "../../packages/contracts/src"].map(path => resolve(root, path));
    const files = ["index.html", "index.css", "package.json", "../../assets/MARS.ico", "../../bun.lock"].map(path => resolve(root, path));
    let timer: NodeJS.Timeout | undefined;
    let build: ChildProcess | undefined;
    let pending = false;
    let closed = false;
    const rebuild = () => {
      timer = undefined;
      if (closed || build || !pending) return;
      pending = false;
      server.config.logger.info("[mars-ui] Rebuilding the control-plane UI bundle…");
      build = spawn("bun", ["run", "build"], { cwd: root, stdio: "inherit" });
      build.once("error", error => server.config.logger.error(`[mars-ui] Build could not start: ${error.message}`));
      build.once("close", code => {
        build = undefined;
        if (closed) return;
        if (code === 0) server.config.logger.info("[mars-ui] UI bundle updated; refresh the control-plane or tunnel page.");
        else server.config.logger.error("[mars-ui] UI build failed; fix the error and save again.");
        if (pending && !timer) timer = setTimeout(rebuild, 150);
      });
    };
    const changed = (_event: string, filename: string) => {
      const path = resolve(filename);
      if (closed || !(files.includes(path) || directories.some(directory => path === directory || path.startsWith(`${directory}${sep}`)))) return;
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(rebuild, 150);
    };
    server.watcher.add([...directories, ...files]);
    server.watcher.on("all", changed);
    server.httpServer?.once("close", () => {
      closed = true;
      clearTimeout(timer);
      server.watcher.off("all", changed);
      build?.kill();
    });
  },
};

export default defineConfig({
  plugins: [TanStackRouterVite({ routesDirectory: "./src/file-routes", generatedRouteTree: "./src/routeTree.gen.ts" }), devEntry, rebuildServedUi, react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": {
        target: process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:3000",
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          proxy.on("error", (error) => {
            if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") console.warn("Control-plane proxy error", error);
          });
        },
      },
    },
  },
});
