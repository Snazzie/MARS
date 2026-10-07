import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "../src");
const sourceFiles: string[] = [];

async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.(?:css|tsx?|jsx?)$/.test(entry.name)) sourceFiles.push(path);
  }
}

await collect(sourceRoot);

const literalColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[^)]*\)/gi;
const namedCssColor = /(?:^|[;{])\s*(?:color|background(?:-color)?|border(?:-[\w-]+)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|accent-color)\s*:[^;{}]*?(?<![\w-])(?:black|white)(?![\w-])/gi;
const namedStyleColor = /\b(?:color|backgroundColor|borderColor|outlineColor|fill|stroke)\s*:\s*["'](?:black|white)["']/gi;
let failures = 0;

const webRoot = resolve(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(resolve(webRoot, "package.json"), "utf8")) as {
  scripts?: { build?: string };
};
const stylesheet = await readFile(resolve(sourceRoot, "styles.css"), "utf8");
if (!manifest.scripts?.build?.includes("tailwindcss") || !stylesheet.includes('@import "tailwindcss";') || !stylesheet.includes("@theme inline")) {
  console.error("Tailwind CSS integration is missing from the stylesheet or production build.");
  failures++;
}
try {
  const builtCss = await readFile(resolve(webRoot, "dist/index.css"), "utf8");
  if (!builtCss.includes(".text-text{color:var(--ui-text)}")) {
    console.error("Production CSS is missing the variable-backed Tailwind text-text utility.");
    failures++;
  }
} catch {
  console.error("Production CSS is missing; run `bun run build` before theme verification.");
  failures++;
}

for (const path of sourceFiles) {
  const original = await readFile(path, "utf8");
  const source = original
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/url\([^)]*\)/gi, "")
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]*/gi, "");
  const allowedThemeRanges = path.endsWith(".css")
    ? [...source.matchAll(/html\[data-theme=["'](?:default|martian)["']\]\s*\{[^}]*\}/g)]
        .map((match) => [match.index!, match.index! + match[0].length] as const)
    : [];
  const patterns = [literalColor, ...(path.endsWith(".css") ? [namedCssColor] : [namedStyleColor])];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const index = match.index!;
      if (allowedThemeRanges.some(([start, end]) => index >= start && index < end)) continue;
      const line = source.slice(0, index).split("\n").length;
      console.error(`${path}:${line}: hardcoded color ${match[0].trim()}`);
      failures++;
    }
  }
}

if (failures) process.exitCode = 1;
else console.log(`Color token verification passed (${sourceFiles.length} source files).`);
