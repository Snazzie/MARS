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

export default defineConfig({
  plugins: [TanStackRouterVite({ routesDirectory: "./src/file-routes", generatedRouteTree: "./src/routeTree.gen.ts" }), devEntry, react()],
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
