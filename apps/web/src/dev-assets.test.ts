import { expect, test } from "bun:test";

test("Vite serves the stylesheet at the production asset URL", async () => {
  const stylesheet = Bun.file(new URL("../index.css", import.meta.url));
  expect(await stylesheet.exists()).toBe(true);
  expect(await stylesheet.text()).toContain("src/styles.css");
});
