const errorMessage = (name: string): string => `${name} must be an absolute HTTP(S) origin`;

export function httpOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(errorMessage(name));
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(errorMessage(name));
  }
  return url.origin;
}

export type BrowserPath = "/" | "/onboarding" | "/repositories" | "/onboarding?github=repository-selection-required";

export function browserLocation(origin: string, path: BrowserPath): string {
  return new URL(path, `${origin}/`).toString();
}
