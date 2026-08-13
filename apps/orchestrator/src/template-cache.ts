import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { TemplateManifest } from "@whitesmith/contracts";

export async function cacheTemplate(manifestValue: unknown, _manifestUrl: string, artifactUrl: string, destination: string): Promise<string> {
  const manifest = TemplateManifest.parse(manifestValue);
  const expected = manifest.template.sha256.toLowerCase();
  const response = await fetch(artifactUrl);
  if (!response.ok || !response.body) throw new Error(`template download failed: ${response.status}`);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  const hash = createHash("sha256");
  try {
    const file = Bun.file(temporary).writer();
    const reader = response.body.getReader();
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; hash.update(chunk.value); await file.write(chunk.value); }
    await file.end();
    const actual = `sha256:${hash.digest("hex")}`;
    if (actual !== expected) throw new Error(`template checksum mismatch: expected ${expected}, got ${actual}`);
    await rename(temporary, destination);
    return destination;
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
