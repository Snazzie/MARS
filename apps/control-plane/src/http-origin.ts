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

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** Normalize a webhook origin and ensure GitHub can reach it over the public internet. */
export function publicHttpOrigin(name: string, value: string): string {
  const origin = httpOrigin(name, value);
  const url = new URL(origin);
  if (url.protocol !== "https:" || privateHost(url.hostname)) throw new Error(`${name} must be a public HTTPS origin`);
  return origin;
}

export type BrowserPath = string;

export function browserLocation(origin: string, path: BrowserPath): string {
  return new URL(path, `${origin}/`).toString();
}
