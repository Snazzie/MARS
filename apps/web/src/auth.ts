import { ApiRequestError, getMe } from "./api.ts";

let redirectingToAuth = false;

export function uiReturnPath(): string {
  const path = `${window.location.pathname}${window.location.search}`;
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/api/") ? path : "/";
}

export function redirectToAuthentication(): never {
  const returnTo = encodeURIComponent(uiReturnPath());
  redirectingToAuth = true;
  window.location.assign(`/api/auth/github?returnTo=${returnTo}`);
  throw new Error("authentication_redirect");
}

export function redirectOnUnauthorized(error: unknown): void {
  if (redirectingToAuth || !(error instanceof ApiRequestError) || error.status !== 401) return;
  redirectToAuthentication();
}

export async function requireAuthentication(): Promise<void> {
  try {
    await getMe();
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) redirectToAuthentication();
    throw error;
  }
}
