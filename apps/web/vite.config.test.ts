import { expect, test } from "bun:test";
import type { IndexHtmlTransformHook, Plugin, UserConfig } from "vite";
import viteConfig from "./vite.config.ts";

function devEntryHook(): IndexHtmlTransformHook {
  const config = viteConfig as UserConfig;
  const plugin = (config.plugins as Plugin[]).find((candidate) => candidate.name === "mars-dev-entry");
  if (!plugin?.transformIndexHtml) throw new Error("mars-dev-entry plugin is missing");
  return plugin.transformIndexHtml;
}

test("rewrites the production bundle entry before Vite scans index.html", async () => {
  const hook = devEntryHook();
  expect(typeof hook).toBe("object");
  if (typeof hook !== "object") throw new Error("development entry transform must declare pre order");
  expect(hook.order).toBe("pre");
  const html = '<script type="module" src="/index.js"></script>';
  expect(await hook.handler.call({}, html, {} as never)).toContain('src="/src/index.tsx"');
});
