export type PrReviewWebhookTrigger = "opened" | "synchronize" | "ready_for_review" | "reopened" | "review_command" | "closed" | "converted_to_draft";
export type PrReviewWebhookEvent = { installationId: number; githubRepositoryId: number; prNumber: number; trigger: PrReviewWebhookTrigger; commentId?: number; requester?: string };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positiveInteger = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const isBot = (user: Record<string, unknown>) => user.type === "Bot" || (typeof user.login === "string" && user.login.toLowerCase().endsWith("[bot]"));

/** Parse only eligible event metadata; authorization, delivery deduplication, and revision capture remain server-owned. */
export function parsePrReviewEvent(event: string, payload: unknown): PrReviewWebhookEvent | null {
  const root = record(payload);
  const installationId = positiveInteger(record(root?.installation)?.id);
  const repositoryId = positiveInteger(record(root?.repository)?.id);
  if (!root || !installationId || !repositoryId) return null;
  if (event === "pull_request") {
    const action = root.action;
    if (action !== "opened" && action !== "synchronize" && action !== "ready_for_review" && action !== "reopened" && action !== "closed" && action !== "converted_to_draft") return null;
    const pr = record(root.pull_request);
    const number = positiveInteger(pr?.number);
    if (!number) return null;
    return { installationId, githubRepositoryId: repositoryId, prNumber: number, trigger: action };
  }
  if (event !== "issue_comment" || root.action !== "created") return null;
  const issue = record(root.issue);
  if (!issue?.pull_request) return null;
  const number = positiveInteger(issue.number);
  const comment = record(root.comment);
  const commentId = positiveInteger(comment?.id);
  const user = record(comment?.user);
  if (!number || !commentId || !user || isBot(user) || typeof user.login !== "string" || typeof comment?.body !== "string" || comment.body.trim() !== "/review") return null;
  return { installationId, githubRepositoryId: repositoryId, prNumber: number, trigger: "review_command", commentId, requester: user.login };
}
