import { expect, test } from "bun:test";
import { renderUnraidReleaseAssets } from "./render-unraid-release";

const options = {
  appVersion: "1.2.3",
  appImage: "ghcr.io/snazzie/mars/control-plane@sha256:" + "a".repeat(64),
  postgresImage: "postgres@sha256:" + "b".repeat(64),
  cloudflaredImage: "cloudflare/cloudflared@sha256:" + "c".repeat(64),
};

test("renders exact versioned XML assets with immutable repositories", async () => {
  const assets = await renderUnraidReleaseAssets(options);
  expect(Object.keys(assets).sort()).toEqual([
    "mars-cloudflared-v1.2.3.xml",
    "mars-control-plane-v1.2.3.xml",
    "mars-postgres-v1.2.3.xml",
  ]);
  expect(assets["mars-control-plane-v1.2.3.xml"]).toContain(`<Repository>${options.appImage}</Repository>`);
  expect(assets["mars-postgres-v1.2.3.xml"]).toContain(`<Repository>${options.postgresImage}</Repository>`);
  expect(assets["mars-cloudflared-v1.2.3.xml"]).toContain(`<Repository>${options.cloudflaredImage}</Repository>`);
  for (const xml of Object.values(assets)) {
    expect(xml).toMatch(/^<\?xml version="1\.0"\?>/);
    expect(xml).toContain("<Container version=\"2\">");
    expect(xml).not.toMatch(/__[^\s<]+__/);
  }
});

test("rejects invalid versions and mutable image references", async () => {
  expect(() => renderUnraidReleaseAssets({ ...options, appVersion: "v1.2.3" })).toThrow("SemVer");
  expect(() => renderUnraidReleaseAssets({ ...options, appImage: "ghcr.io/snazzie/mars/control-plane:v1.2.3" })).toThrow("repository@sha256");
  expect(() => renderUnraidReleaseAssets({ ...options, postgresImage: "postgres@sha256:" + "A".repeat(64) })).toThrow("repository@sha256");
  expect(() => renderUnraidReleaseAssets({ ...options, cloudflaredImage: "cloudflare/cloudflared@sha256:short" })).toThrow("repository@sha256");
});
