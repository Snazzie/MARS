import type { PrReviewResult } from "@mars/contracts";
import type { GithubPullRequest, GithubPrReviewClient, GithubPullRequestFile } from "./github-pr-review.ts";

export const PR_REVIEW_MAX_FILES = 40;
export const PR_REVIEW_MAX_SOURCE_BYTES = 32 * 1024;
export const PR_REVIEW_MAX_CONTEXT_BYTES = 64 * 1024;
export const PR_REVIEW_MAX_RULES_BYTES = 8 * 1024;
export const PR_REVIEW_MIN_CONFIDENCE = 60;

export type PrReviewPullRequest = GithubPullRequest;
export type PrReviewContextClient = Pick<GithubPrReviewClient, "files" | "source" | "getContent">;
export interface PrReviewContextFile {
  path: string;
  status: string;
  patch: string | null;
  headSource: string | null;
  coverage: "reviewable" | "missing_patch" | "deleted" | "renamed" | "excluded" | "source_unavailable" | "limited";
  changedLines: number[];
  diffPositions: Record<number, number>;
  hunkIds: Record<number, number>;
}
export interface PrReviewContext {
  pullRequest: { number: number; title: string; description: string | null; baseSha: string; headSha: string };
  files: PrReviewContextFile[];
  rules: { path: ".mars/pr-rules.md"; baseSha: string; blobSha: string | null; status: "present" | "missing" | "failed"; text: string | null };
  coverage: { changedFiles: number; consideredFiles: number; reviewableFiles: number; omittedFiles: number; complete: boolean; limitations: string[] };
}

export class PrReviewRulesError extends Error {
  readonly rules: PrReviewContext["rules"];
  constructor(rules: PrReviewContext["rules"], code: "pr_review_rules_unavailable" | "pr_review_rules_too_large" | "pr_review_rules_unsupported" | "github_app_permissions_missing") { super(code); this.name = "PrReviewRulesError"; this.rules = rules; }
}

const generatedOrBinary = (path: string) => /(?:^|\/)(?:vendor|node_modules|dist|build|coverage|\.next|generated|__generated__)(?:\/|$)/i.test(path)
  || /(?:\.min\.(?:js|css)|\.map|\.lock|\.generated\.[^.]+|\.gen\.[^.]+|\.svg|\.png|\.jpe?g|\.gif|\.webp|\.ico|\.avif|\.pdf|\.zip|\.tar|\.gz|\.wasm|\.snap|\.woff2?|\.ttf|\.eot|\.mp[34]|\.db|\.dll|\.exe|\.class|\.jar)$/i.test(path)
  || /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i.test(path);
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

function parsePatch(patch: string | undefined): { changedLines: number[]; diffPositions: Record<number, number>; hunkIds: Record<number, number> } {
  const changedLines: number[] = [], diffPositions: Record<number, number> = {}, hunkIds: Record<number, number> = {};
  if (!patch) return { changedLines, diffPositions, hunkIds };
  let newLine = 0, position = 0, hunkId = -1;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)(?:,\d+)?/);
      if (match) newLine = Number(match[1]);
      hunkId++;
      continue;
    }
    position++;
    if (line.startsWith("+")) { changedLines.push(newLine); diffPositions[newLine] = position; hunkIds[newLine] = hunkId; newLine++; }
    else if (line.startsWith(" ")) newLine++;
  }
  return { changedLines, diffPositions, hunkIds };
}

export async function collectPrReviewContext(client: PrReviewContextClient, owner: string, repo: string, pr: PrReviewPullRequest): Promise<PrReviewContext> {
  const rulePath = ".mars/pr-rules.md";
  let rule: PrReviewContext["rules"];
  let rulesBlobSha: string | null = null;
  try {
    const loaded = await client.getContent(owner, repo, rulePath, pr.baseSha);
    rulesBlobSha = loaded?.sha ?? null;
    if (loaded && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(loaded.text)) throw new Error("github_content_unsupported");
    if (!loaded) rule = { path: rulePath, baseSha: pr.baseSha, blobSha: null, status: "missing", text: null };
    else if (byteLength(loaded.text) > PR_REVIEW_MAX_RULES_BYTES) throw new Error("pr_review_rules_too_large");
    else rule = { path: rulePath, baseSha: pr.baseSha, blobSha: loaded.sha, status: "present", text: loaded.text };
  } catch (error) {
    rule = { path: rulePath, baseSha: pr.baseSha, blobSha: rulesBlobSha, status: "failed", text: null };
    const message = error instanceof Error ? error.message : "";
    const code = message === "pr_review_rules_too_large" ? message : message === "github_content_unsupported" ? "pr_review_rules_unsupported" : message === "github_401" || message === "github_403" ? "github_app_permissions_missing" : "pr_review_rules_unavailable";
    throw new PrReviewRulesError(rule, code);
  }

  const listed = await client.files(owner, repo, pr.number);
  const files: PrReviewContextFile[] = [], limitations: string[] = [];
  const omittedFiles = Math.max(0, listed.length - PR_REVIEW_MAX_FILES);
  if (omittedFiles) limitations.push(`${omittedFiles} changed files omitted by the ${PR_REVIEW_MAX_FILES}-file limit.`);
  const title = pr.title.slice(0, 2000);
  if (pr.title.length > title.length) limitations.push("Pull request title exceeded the context limit and was bounded.");
  let description = pr.body;
  let total = byteLength(title) + byteLength(rule.text ?? "");
  const descriptionBytes = byteLength(description ?? "");
  if (total + descriptionBytes > PR_REVIEW_MAX_CONTEXT_BYTES) {
    const allowed = Math.max(0, PR_REVIEW_MAX_CONTEXT_BYTES - total - byteLength("\n[description limited]"));
    description = description ? Buffer.from(description, "utf8").subarray(0, allowed).toString("utf8") + "\n[description limited]" : null;
    total = byteLength(title) + byteLength(rule.text ?? "") + byteLength(description ?? "");
    limitations.push("Pull request description exceeded the context limit and was bounded.");
  } else total += descriptionBytes;
  let reviewableFiles = 0;
  for (const item of listed.slice(0, PR_REVIEW_MAX_FILES)) {
    const unsafePath = !safeRepositoryPath(item.filename);
    const generated = unsafePath || generatedOrBinary(item.filename);
    const patchFits = !generated && Boolean(item.patch) && total + byteLength(item.filename) + byteLength(item.patch!) <= PR_REVIEW_MAX_CONTEXT_BYTES;
    let patch = patchFits ? item.patch! : null;
    if (patch) total += byteLength(item.filename) + byteLength(patch);
    let parsed = parsePatch(patch ?? undefined);
    let coverage: PrReviewContextFile["coverage"], headSource: string | null = null;
    const deleted = item.status === "removed" || item.status === "deleted";
    const renamed = item.status === "renamed" || Boolean(item.previousFilename);
    if (deleted) coverage = "deleted";
    else if (renamed) coverage = "renamed";
    else if (generated) coverage = "excluded";
    else if (item.patch && !patchFits) coverage = "limited";
    else if (!patch) coverage = "missing_patch";
    else {
      try {
        const loaded = await client.source(owner, repo, item.filename, pr.headSha);
        if (!loaded) coverage = "source_unavailable";
        else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(loaded.text)) {
          total -= byteLength(item.filename) + byteLength(patch);
          patch = null;
          parsed = parsePatch(undefined);
          coverage = "excluded";
        } else if (byteLength(loaded.text) > PR_REVIEW_MAX_SOURCE_BYTES) coverage = "limited";
        else if (total + byteLength(loaded.text) > PR_REVIEW_MAX_CONTEXT_BYTES) coverage = "limited";
        else { headSource = loaded.text; total += byteLength(loaded.text); coverage = "reviewable"; reviewableFiles++; }
      } catch { coverage = "source_unavailable"; }
    }
    if (coverage !== "reviewable") limitations.push(`${item.filename.slice(0, 256)}${item.filename.length > 256 ? "…" : ""}: ${coverage.replaceAll("_", " ")}.`);
    files.push({ path: item.filename, status: item.status, patch, headSource, coverage, ...parsed });
  }
  if (pr.changedFiles > listed.length) limitations.push(`${pr.changedFiles - listed.length} changed files were not returned by GitHub.`);
  const context: PrReviewContext = {
    pullRequest: { number: pr.number, title, description, baseSha: pr.baseSha, headSha: pr.headSha }, files,
    rules: rule,
    coverage: { changedFiles: pr.changedFiles, consideredFiles: files.length, reviewableFiles, omittedFiles: omittedFiles + Math.max(0, pr.changedFiles - listed.length), complete: limitations.length === 0, limitations },
  };
  while (byteLength(JSON.stringify(context)) > PR_REVIEW_MAX_CONTEXT_BYTES) {
    const excess = byteLength(JSON.stringify(context)) - PR_REVIEW_MAX_CONTEXT_BYTES;
    if (context.pullRequest.description) {
      const description = context.pullRequest.description;
      context.pullRequest.description = Buffer.from(description, "utf8").subarray(0, Math.max(0, byteLength(description) - excess - 64)).toString("utf8");
      context.coverage.limitations.push("Pull request description was further bounded to fit the context limit.");
    } else if (context.files.length) {
      const file = context.files.pop()!;
      if (file.coverage === "reviewable") context.coverage.reviewableFiles--;
      context.coverage.omittedFiles++;
      context.coverage.consideredFiles--;
      context.coverage.limitations.push(`${file.path.slice(0, 256)}${file.path.length > 256 ? "…" : ""}: omitted to fit the context limit.`);
    } else break;
    context.coverage.complete = false;
  }
  if (byteLength(JSON.stringify(context)) > PR_REVIEW_MAX_CONTEXT_BYTES) throw new Error("pr_review_context_too_large");
  return context;
}

export async function fitPrReviewContext(
  context: PrReviewContext,
  fits: (context: PrReviewContext) => Promise<boolean>,
): Promise<PrReviewContext> {
  const fitted: PrReviewContext = {
    pullRequest: { ...context.pullRequest },
    files: context.files.map(file => ({
      ...file,
      changedLines: [...file.changedLines],
      diffPositions: { ...file.diffPositions },
      hunkIds: { ...file.hunkIds },
    })),
    rules: { ...context.rules },
    coverage: { ...context.coverage, limitations: [...context.coverage.limitations] },
  };
  const markLimited = (message: string) => {
    if (!fitted.coverage.limitations.includes(message)) fitted.coverage.limitations.push(message);
    fitted.coverage.complete = false;
  };
  if (await fits(fitted)) return fitted;

  if (fitted.pullRequest.description !== null) {
    fitted.pullRequest.description = null;
    markLimited("Pull request description omitted to fit the model context limit.");
    if (await fits(fitted)) return fitted;
  }

  const metadata = fitted.files.filter(file => file.coverage !== "reviewable");
  if (metadata.length) {
    const removed = new Set(metadata);
    fitted.files = fitted.files.filter(file => !removed.has(file));
    fitted.coverage.consideredFiles -= metadata.length;
    fitted.coverage.omittedFiles += metadata.length;
    for (const file of metadata) {
      markLimited(`${file.path.slice(0, 256)}${file.path.length > 256 ? "…" : ""}: metadata omitted to fit the model context limit.`);
    }
    if (await fits(fitted)) return fitted;
  }

  while (fitted.coverage.reviewableFiles > 1) {
    const index = fitted.files.findLastIndex(file => file.coverage === "reviewable");
    if (index < 0) break;
    const [file] = fitted.files.splice(index, 1);
    fitted.coverage.reviewableFiles--;
    fitted.coverage.consideredFiles--;
    fitted.coverage.omittedFiles++;
    markLimited(`${file!.path.slice(0, 256)}${file!.path.length > 256 ? "…" : ""}: omitted to fit the model context limit.`);
    if (await fits(fitted)) return fitted;
  }

  throw new Error("pr_review_context_too_large");
}

const unsafeText = (value: string) => value.replace(/@/g, "@\u200b").replace(/https?:\/\//gi, m => m.replace(":", "&#58;")).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
function markdownText(value: string): string {
  return unsafeText(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/([\\`*_{}\[\]()#+\-.!|])/g, "\\$1").replace(/\s+/g, " ").trim();
}
function markdownCode(value: string): string {
  const fence = "`".repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length)) + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

const safeRepositoryPath = (path: string) => path.length > 0 && !path.startsWith("/") && !path.includes("\\")
  && !/[\u0000-\u001f\u007f]/.test(path) && !path.split("/").some(part => part === "" || part === "." || part === "..");
function hasInlineLocation(finding: PrReviewResult["findings"][number], file: PrReviewContextFile): boolean {
  if (!file.headSource) return false;
  const endLine = finding.endLine ?? finding.line;
  const lines = file.headSource.split("\n");
  if (!Number.isInteger(finding.line) || finding.line < 1 || !Number.isInteger(endLine) || endLine < finding.line || endLine > lines.length || endLine - finding.line > 9) return false;
  const hunk = file.hunkIds[finding.line];
  if (hunk === undefined || file.hunkIds[endLine] !== hunk) return false;
  for (let line = finding.line; line <= endLine; line++) if (!file.changedLines.includes(line)) return false;
  return lines.slice(finding.line - 1, endLine).join("\n").includes(finding.evidence.trim());
}

function hasSupportedSuggestion(finding: PrReviewResult["findings"][number], file: PrReviewContextFile): boolean {
  const suggestion = finding.suggestion;
  if (!suggestion || !file.headSource) return false;
  const lines = file.headSource.split("\n");
  if (!Number.isInteger(suggestion.startLine) || !Number.isInteger(suggestion.endLine) || suggestion.startLine < 1 || suggestion.endLine < suggestion.startLine || suggestion.endLine > lines.length
    || suggestion.endLine - suggestion.startLine > 4 || byteLength(suggestion.replacementText) > 4000 || /`{3,}/.test(suggestion.replacementText) || !suggestion.rationale.trim()) return false;
  const hunk = file.hunkIds[suggestion.startLine];
  if (hunk === undefined || file.hunkIds[suggestion.endLine] !== hunk) return false;
  for (let line = suggestion.startLine; line <= suggestion.endLine; line++) if (!file.changedLines.includes(line)) return false;
  return lines.slice(suggestion.startLine - 1, suggestion.endLine).join("\n") === suggestion.originalText;
}

export function validatePrReviewFindings(result: PrReviewResult, context: PrReviewContext): PrReviewResult {
  const accepted: PrReviewResult["findings"] = [];
  const seen = new Set<string>();
  const suggestionIndices: Array<{ index: number; path: string; start: number; end: number }> = [];
  for (const finding of result.findings.slice(0, 20)) {
    if (!Number.isInteger(finding.confidencePercent) || finding.confidencePercent < PR_REVIEW_MIN_CONFIDENCE || finding.confidencePercent > 100
      || !["Critical", "High", "Medium", "Low"].includes(finding.severity) || !finding.path || !safeRepositoryPath(finding.path)
      || !Number.isInteger(finding.line) || finding.line < 1 || !finding.evidence.trim() || !finding.impact.trim() || !finding.correction.trim()) continue;
    const file = context.files.find(item => item.path === finding.path);
    if (!file || file.coverage === "excluded" || !file.patch || !file.patch.includes(finding.evidence.trim()) || file.headSource && !file.headSource.includes(finding.evidence.trim())) continue;
    const endLine = finding.endLine ?? finding.line;
    if (!Number.isInteger(endLine) || endLine < finding.line) continue;
    const duplicateKey = `${finding.path}\0${finding.line}\0${finding.impact.trim()}`;
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    const inline = file.coverage === "reviewable" && hasInlineLocation(finding, file);
    let suggestion = inline && hasSupportedSuggestion(finding, file) ? finding.suggestion : null;
    const acceptedFinding = { ...finding, endLine, evidence: finding.evidence.slice(0, 2000), impact: finding.impact.slice(0, 1000), correction: finding.correction.slice(0, 1000), suggestion };
    accepted.push(acceptedFinding);
    if (suggestion) suggestionIndices.push({ index: accepted.length - 1, path: finding.path, start: suggestion.startLine, end: suggestion.endLine });
  }
  const conflicting = new Set<number>();
  for (let left = 0; left < suggestionIndices.length; left++) for (let right = left + 1; right < suggestionIndices.length; right++) {
    const first = suggestionIndices[left]!, second = suggestionIndices[right]!;
    if (first.path === second.path && first.start <= second.end && second.start <= first.end) { conflicting.add(first.index); conflicting.add(second.index); }
  }
  for (const index of conflicting) accepted[index] = { ...accepted[index]!, suggestion: null };
  return { findings: accepted };
}

export interface PrReviewInlineComment { path: string; line: number; start_line?: number; side: "RIGHT"; start_side?: "RIGHT"; body: string }
export function renderPrReview(result: PrReviewResult, context: PrReviewContext, marker: string): { body: string; comments: PrReviewInlineComment[] } {
  const validated = validatePrReviewFindings(result, context);
  const comments: PrReviewInlineComment[] = [];
  const summaryOnly: string[] = [];
  const maxInlineBytes = 44 * 1024;
  let inlineBytes = 0;
  for (const finding of validated.findings) {
    const file = context.files.find(item => item.path === finding.path)!;
    const findingLine = finding.endLine ?? finding.line;
    const locationValid = file.coverage === "reviewable" && hasInlineLocation(finding, file);
    const suggestion = finding.suggestion;
    const startLine = suggestion?.startLine ?? finding.line;
    const line = suggestion?.endLine ?? findingLine;
    const inline = locationValid && Boolean(file.diffPositions[startLine]) && Boolean(file.diffPositions[line]);
    const location = locationValid ? `${finding.path}:${finding.line}${findingLine !== finding.line ? `-${findingLine}` : ""}` : finding.path;
    const bullet = `- **${finding.severity} · ${finding.confidencePercent}% confidence** — ${markdownCode(location)}: ${markdownText(finding.impact)} Correction: ${markdownText(finding.correction)}`;
    if (!inline) { summaryOnly.push(bullet); continue; }
    const sections = [bullet];
    if (suggestion) {
      sections.push(markdownText(suggestion.rationale), `\`\`\`suggestion\n${suggestion.replacementText}\n\`\`\``);
    }
    const commentBody = sections.join("\n\n");
    const commentBytes = byteLength(commentBody);
    if (inlineBytes + commentBytes > maxInlineBytes) { summaryOnly.push(bullet); continue; }
    inlineBytes += commentBytes;
    comments.push({ path: finding.path, line, ...(line !== startLine ? { start_line: startLine, start_side: "RIGHT" as const } : {}), side: "RIGHT", body: commentBody });
  }
  const cov = context.coverage;
  const coverage = cov.complete ? "Coverage: all returned changed files were reviewed." : `Coverage limitations: ${context.coverage.limitations.map(markdownText).join("; ")}`;
  const findings = summaryOnly.length ? summaryOnly.join("\n") : validated.findings.length ? "Actionable findings are described in the inline comments." : "No actionable findings in the reviewed scope.";
  const rules = context.rules.status === "present" ? `Base rules: ${context.rules.path} at ${context.rules.baseSha} (blob ${context.rules.blobSha}).` : `Base rules: ${context.rules.status === "missing" ? "none present" : "loading failed"} at ${context.rules.path} (${context.rules.baseSha}).`;
  const disclaimer = "AI-generated advisory review; verify findings and suggestions. This is not an approval or exhaustive safety guarantee.";
  const primary = [`<!-- ${marker.replace(/[<>\r\n]/g, "")} -->`, "## MARS AI pull request review", `Reviewed head: \`${context.pullRequest.headSha}\` (base \`${context.pullRequest.baseSha}\`).`, rules, coverage, "", findings].join("\n");
  const maxPrimaryBytes = 49_000 - byteLength(disclaimer) - 1;
  const bytes = Buffer.from(primary, "utf8");
  let end = Math.min(bytes.length, maxPrimaryBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  const body = `${bytes.subarray(0, end).toString("utf8")}\n${disclaimer}`;
  return { body, comments };
  }
