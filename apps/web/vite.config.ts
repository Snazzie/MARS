import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const devEntry: Plugin = {
  name: "whitesmith-dev-entry",
  transformIndexHtml(html) {
    return html.replace('src="/index.js"', 'src="/src/index.tsx"');
  },
};

export default defineConfig({
  plugins: [devEntry, react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": {
        target: process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
});
