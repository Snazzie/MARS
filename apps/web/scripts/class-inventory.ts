import { parse } from "@babel/parser";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "../src");
const appRoot = resolve(import.meta.dir, "../");
const sourceFiles: string[] = [];

async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.(?:tsx?|css)$/.test(entry.name)) sourceFiles.push(path);
  }
}

await collect(sourceRoot);

const markupFiles = new Map<string, Set<string>>();
const dynamicPrefixes = new Map<string, Set<string>>();
const testSelectorFiles = new Map<string, Set<string>>();
for (const path of sourceFiles.filter((file) => !file.endsWith(".css"))) {
  const text = await readFile(path, "utf8");
  const ast = parse(text, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
  const add = (value: string) => {
    for (const token of value.split(/\s+/).filter(Boolean)) {
      const paths = markupFiles.get(token) ?? new Set<string>();
      paths.add(relative(appRoot, path).replaceAll("\\", "/"));
      markupFiles.set(token, paths);
    }
  };
  const addTestSelectors = (selector: string) => {
    for (const [, token] of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      const paths = testSelectorFiles.get(token) ?? new Set<string>();
      paths.add(relative(appRoot, path).replaceAll("\\", "/"));
      testSelectorFiles.set(token, paths);
    }
  };
  type AstNode = { type?: string; value?: unknown; quasis?: unknown; name?: unknown; key?: unknown; [key: string]: unknown };
  const collectStrings = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as AstNode;
    if (node.type === "StringLiteral" && typeof node.value === "string") add(node.value);
    else if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
      for (const [index, item] of node.quasis.entries()) {
        if (!item || typeof item !== "object") continue;
        const quasi = item as AstNode;
        if (!quasi.value || typeof quasi.value !== "object") continue;
        const quasiValue = quasi.value as AstNode;
        const text = typeof quasiValue.cooked === "string" ? quasiValue.cooked : quasiValue.raw;
        if (typeof text !== "string") continue;
        add(text);
        if (index < node.quasis.length - 1) {
          const prefix = text.trim().split(/\s+/).at(-1);
          if (prefix?.endsWith("-") || prefix?.endsWith("_")) {
            const paths = dynamicPrefixes.get(prefix) ?? new Set<string>();
            paths.add(relative(appRoot, path).replaceAll("\\", "/"));
            dynamicPrefixes.set(prefix, paths);
          }
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "comments", "tokens"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(collectStrings);
      else collectStrings(child);
    }
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const node = value as AstNode;
    const name = node.name && typeof node.name === "object" ? node.name as AstNode : undefined;
    const key = node.key && typeof node.key === "object" ? node.key as AstNode : undefined;
    const callee = node.callee && typeof node.callee === "object" ? node.callee as AstNode : undefined;
    const property = callee?.property && typeof callee.property === "object" ? callee.property as AstNode : undefined;
    if (path.includes(".test.") && node.type === "CallExpression" && ["querySelector", "querySelectorAll"].includes(String(property?.name))) {
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      for (const argument of args) {
        if (!argument || typeof argument !== "object") continue;
        const selector = argument as AstNode;
        if (selector.type === "StringLiteral" && typeof selector.value === "string") addTestSelectors(selector.value);
        else if (selector.type === "TemplateLiteral" && Array.isArray(selector.quasis)) {
          for (const item of selector.quasis) {
            if (!item || typeof item !== "object") continue;
            const quasi = item as AstNode;
            if (!quasi.value || typeof quasi.value !== "object") continue;
            const quasiValue = quasi.value as AstNode;
            const text = typeof quasiValue.cooked === "string" ? quasiValue.cooked : quasiValue.raw;
            if (typeof text === "string") addTestSelectors(text);
          }
        }
      }
    }
    if (node.type === "JSXAttribute" && name?.type === "JSXIdentifier" && name.name === "className") {
      collectStrings(node.value);
    } else if (node.type === "ObjectProperty" && key?.type === "Identifier" && key.name === "className") {
      collectStrings(node.value);
    }
    for (const [property, child] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "comments", "tokens"].includes(property)) continue;
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(ast);
}

const cssPath = sourceFiles.find((file) => file.endsWith("styles.css"));
if (!cssPath) throw new Error("Could not find apps/web/src/styles.css");
const css = (await readFile(cssPath, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
const authored = new Map<string, Set<number>>();
const integrations = new Map<string, Set<number>>();
for (const match of css.matchAll(/([^{}]+)\{/g)) {
  const selector = match[1].trim();
  if (selector.startsWith("@")) continue;
  const line = css.slice(0, match.index).split("\n").length;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) {
    const collection = /^(?:react-flow(?:__|$)|xy-flow(?:__|$))/.test(name) ? integrations : authored;
    const lines = collection.get(name) ?? new Set<number>();
    lines.add(line);
    collection.set(name, lines);
  }
}

const isMarkupClass = (selector: string): boolean =>
  markupFiles.has(selector) ||
  testSelectorFiles.has(selector) ||
  [...dynamicPrefixes.keys()].some((prefix) => selector.startsWith(prefix));
const classTokens = new Set([...markupFiles.keys(), ...testSelectorFiles.keys()]);
const classes = [...classTokens]
  .sort((left, right) => left.localeCompare(right))
  .map((token) => {
    const files = new Set([...(markupFiles.get(token) ?? []), ...(testSelectorFiles.get(token) ?? [])]);
    return {
      token,
      files: [...files].sort(),
      jsxFiles: [...(markupFiles.get(token) ?? [])].sort(),
      testSelectorFiles: [...(testSelectorFiles.get(token) ?? [])].sort(),
      authoredSelector: authored.has(token),
      integrationSelector: integrations.has(token),
      dynamicPrefix: dynamicPrefixes.has(token),
    };
  });
const unmatchedMarkup = classes.filter((item) => !item.authoredSelector && !item.integrationSelector && !item.dynamicPrefix);
const authoredSelectors = [...authored]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([selector, lines]) => ({
    selector,
    file: relative(appRoot, cssPath).replaceAll("\\", "/"),
    lines: [...lines].sort((a, b) => a - b),
    usedInMarkup: isMarkupClass(selector),
  }));
const integrationStyles = [...integrations]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([selector, lines]) => ({
    selector,
    file: relative(appRoot, cssPath).replaceAll("\\", "/"),
    lines: [...lines].sort((a, b) => a - b),
  }));
const unusedAuthoredSelectors = authoredSelectors.filter((item) => !item.usedInMarkup);
const dynamicMarkupPrefixes = [...dynamicPrefixes]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([prefix, files]) => ({ prefix, files: [...files].sort() }));
const report = {
  summary: {
    markupTokens: classes.length,
    authoredSelectors: authoredSelectors.length,
    integrationSelectors: integrationStyles.length,
    dynamicPrefixes: dynamicMarkupPrefixes.length,
    unmatchedMarkup: unmatchedMarkup.length,
    unusedAuthoredSelectors: unusedAuthoredSelectors.length,
  },
  classes,
  authoredSelectors,
  integrationStyles,
  dynamicMarkupPrefixes,
  unmatchedMarkup,
  unusedAuthoredSelectors,
};
await writeFile(resolve(appRoot, "class-inventory.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary));
