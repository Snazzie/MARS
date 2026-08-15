import { expect, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { OnboardingPage } from "./OnboardingPage.tsx";

const worker = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "linux-builder",
  platform: "linux-x64",
  admissionState: "adopted",
  connectionState: "online",
  configurationState: "ready",
  publicKey: "ssh-ed25519 AAAA",
  fingerprint: "SHA256:worker",
  vmUuid: "22222222-2222-4222-8222-222222222222",
  machineUuid: "33333333-3333-4333-8333-333333333333",
  doctor: { nestedKvm: true, probe: true },
  capacity: { actualVcpu: 8, actualMemoryBytes: 17179869184, actualStorageBytes: 214748364800, freeVcpu: 8, freeMemoryBytes: 17179869184, freeStorageBytes: 214748364800 },
  limits: null,
  configurationRevision: "rev-1",
};

function markup(detail: Record<string, unknown>, pendingWorkers?: readonly unknown[]) {
  const client = new QueryClient();
  client.setQueryData(["onboarding-status"], detail);
  client.setQueryData(["onboarding"], detail);
  if (pendingWorkers) client.setQueryData(["pending-workers"], pendingWorkers);
  return renderToStaticMarkup(<QueryClientProvider client={client}><OnboardingPage /></QueryClientProvider>);
}

test("first-admin sign-in copy explains administrator setup and links GitHub OAuth", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: false, authenticated: false, canManage: false, step: "admin" });
  expect(html).toContain("Create your administrator account");
  expect(html).toContain("Continue with GitHub");
  expect(html).toContain('href="/api/auth/github"');
  expect(html).toContain("GitHub identity");
});

test("returning administrator sign-in copy names Whitesmith", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: false, canManage: false, step: "admin" });
  expect(html).toContain("Sign in to Whitesmith");
});

test("authenticated non-admin sees authorization terminal state without setup data", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: false, step: "worker" });
  expect(html).toContain("Administrator access required");
  expect(html).not.toContain("linux-builder");
  expect(html).not.toContain("GitHub organization");
  expect(html).not.toContain("repositories");
  expect(html).not.toContain("Pool");
});

test("worker step combines selection, capacity configuration, and four-step progress", () => {
  const selectedWorker = { ...worker, configurationState: "unconfigured", limits: null };
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "worker", worker: selectedWorker, organizations: [], github: { appConfigured: true, organizationId: null, installation: null, repositories: [] }, pool: null, defaultImageDigest: "ubuntu@sha256:" + "a".repeat(64) });
  for (const [label, className] of [["Admin", "is-complete"], ["Worker", "is-current"], ["GitHub", "is-locked"], ["Trigger labels", "is-locked"]]) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const element = html.match(new RegExp(`<li[^>]*>[^<]*<span>[^<]*</span>(?:<strong>|<button[^>]*>)${escaped}(?:</strong>|</button>)</li>`))?.[0] ?? "";
    expect(element).toContain(className);
  }
  expect(html).not.toContain("<strong>Resources</strong>");
  expect(html).toContain("Progress is saved");
  expect(html).toContain("Configure resources");
  expect(html).toContain("GiB");
});

test("current step includes read-only summaries of completed worker and GitHub steps", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "labels", worker, organizations: [{ id: "org-1", name: "Acme", login: "acme", repositoryCount: 1, workerCount: 1 }], github: { appConfigured: true, organizationId: "org-1", installation: { id: "inst-1", githubInstallationId: 42, state: "approved", repositorySelection: "selected" }, repositories: [{ id: "repo-1", name: "private", fullName: "acme/private", visibility: "private", available: true }] }, pool: null, defaultImageDigest: "ubuntu@sha256:" + "a".repeat(64) });
  expect(html).toContain("linux-builder");
  expect(html).toContain("Acme");
  expect(html).toContain("Available repositories: 1");
  expect(html).not.toContain("Repositories: private");
});
test("completed onboarding steps expose editable controls", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "labels", worker, organizations: [{ id: "org-1", name: "Acme", login: "acme", repositoryCount: 1, workerCount: 1 }], github: { appConfigured: true, organizationId: "org-1", installation: { id: "inst-1", githubInstallationId: 42, state: "approved", repositorySelection: "selected" }, repositories: [{ id: "repo-1", name: "private", fullName: "acme/private", visibility: "private", available: true }] }, pool: null, defaultImageDigest: "ubuntu@sha256:" + "a".repeat(64) });
  expect(html).toContain('aria-label="Edit Worker step"');
});

test("admin and sign-in states expose the appropriate GitHub action", () => {
  expect(markup({ version: 1, onboardingRequired: true, adminCreated: false, authenticated: false, canManage: false, step: "admin" })).toContain("Create administrator with GitHub");
  expect(markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: false, canManage: false, step: "admin" })).toContain("Sign in with GitHub");
});

test("renders four-step progress with only the server current step enabled", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "github", worker, organizations: [], github: { appConfigured: true, organizationId: null, installation: null, repositories: [] }, pool: null, defaultImageDigest: "ubuntu@sha256:" + "a".repeat(64) });
  for (const label of ["Admin", "Worker", "GitHub", "Trigger labels"]) expect(html).toContain(label);
  expect(html).not.toContain("<strong>Resources</strong>");
  expect(html).toContain("Worker enrollment");
  expect(html).toContain("GitHub account");
});

test("worker step renders enrollment inline and requires explicit selection", () => {
  const detail = { version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "worker", worker: null, organizations: [], github: { appConfigured: false, organizationId: null, installation: null, repositories: [] }, pool: null, defaultImageDigest: null };
  const html = markup(detail, [{ ...worker, admissionState: "pending" }]);
  expect(html).toContain("Worker enrollment");
  expect(html).toContain("Generate bootstrap code");
  expect(html).toContain("Use this worker");
  expect(html).not.toContain("<dialog");
  expect(html).not.toContain("Rotate bootstrap code");
});

test("completed review does not invent a selected worker", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "github", worker: null, organizations: [], github: { appConfigured: true, organizationId: "org-1", installation: null, repositories: [] }, pool: null, defaultImageDigest: null });
  expect(html).not.toContain("Worker: Selected");
});
test("worker loading errors preserve choices and expose retry", async () => {
  const detail = { version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "worker", worker: null, organizations: [], github: { appConfigured: false, organizationId: null, installation: null, repositories: [] }, pool: null, defaultImageDigest: null };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["onboarding-status"], detail);
  client.setQueryData(["onboarding"], detail);
  client.setQueryData(["pending-workers"], [{ ...worker, admissionState: "pending" }]);
  await expect(client.fetchQuery({ queryKey: ["pending-workers"], queryFn: async () => { throw new Error("pending endpoint unavailable"); } })).rejects.toThrow("pending endpoint unavailable");
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><OnboardingPage /></QueryClientProvider>);
  expect(html).toContain("pending endpoint unavailable");
  expect(html).toContain("Retry");
  expect(html).toContain("Use this worker");
});

test("uses GitHub installation access without rendering repository approval controls", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "github", worker, organizations: [{ id: "org-1", name: "Acme", login: "acme", repositoryCount: 2, workerCount: 1 }], github: { appConfigured: true, organizationId: "org-1", installation: { id: "inst-1", githubInstallationId: 42, state: "approved", repositorySelection: "all" }, repositories: [{ id: "repo-1", name: "private", fullName: "acme/private", visibility: "private", available: true }, { id: "repo-2", name: "public", fullName: "acme/public", visibility: "public", available: true }] }, pool: null, defaultImageDigest: null });
  expect(html).toContain("GitHub installation connected");
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain("Approve repositories");
  expect(html).not.toContain("<form");
});
test("repository selection remediation explains the GitHub setting and permits reconnect", () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: "?github=repository-selection-required" } } });
  try {
    const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "github", worker: null, organizations: [{ id: "org-1", name: "Acme", login: "acme", repositoryCount: 0, workerCount: 1 }], github: { appConfigured: true, organizationId: "org-1", installation: { id: "inst-1", githubInstallationId: 42, state: "pending", repositorySelection: "all" }, repositories: [] }, pool: null, defaultImageDigest: null });
    expect(html).toContain("No available repositories");
    expect(html).toContain("installation access");
    expect(html).toContain("Install Whitesmith GitHub App");
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});
test("registers an unconfigured GitHub App through the manifest flow", async () => {
  const browser = new Window({ url: "http://localhost/onboarding" });
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  // @ts-expect-error Happy DOM provides the browser globals React needs.
  globalThis.document = browser.document;
  // @ts-expect-error Happy DOM provides the browser globals React needs.
  globalThis.window = browser;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const requests: string[] = [];
  let submitted: HTMLFormElement | null = null;
  const submittedForm = (): HTMLFormElement | null => submitted;
  browser.HTMLFormElement.prototype.submit = function submit() { submitted = this as unknown as HTMLFormElement; };
  globalThis.fetch = (async (input) => {
    const path = String(input);
    requests.push(path);
    if (path === "/api/github/app/manifest") return Response.json({ action: "https://github.com/settings/apps/new?state=test", manifest: "{\"name\":\"whitesmith\"}" });
    if (path === "/api/github/app/install") return Response.json({ location: "http://localhost/onboarding" });
    return Response.json({ code: "unexpected_request" }, { status: 500 });
  }) as typeof globalThis.fetch;
  const detail = { version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "github", worker, organizations: [{ id: "org-1", name: "Acme", login: "acme", repositoryCount: 0, workerCount: 0 }], github: { appConfigured: false, organizationId: null, installation: null, repositories: [] }, pool: null, defaultImageDigest: null };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["onboarding-status"], detail);
  client.setQueryData(["onboarding"], detail);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><OnboardingPage /></QueryClientProvider>); });
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="GitHub account"]') ?? container.querySelector<HTMLSelectElement>('select[aria-label="GitHub organization"]');
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = "org-1";
      select!.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
    });
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes("GitHub App"));
    await act(async () => {
      button?.click();
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
    });
    expect(requests).toEqual(["/api/github/app/manifest"]);
    expect(submittedForm()?.method).toBe("post");
    expect(submittedForm()?.action).toBe("https://github.com/settings/apps/new?state=test");
    expect(submittedForm()?.querySelector<HTMLInputElement>('input[name="manifest"]')?.value).toBe("{\"name\":\"whitesmith\"}");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.fetch = previousFetch;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});



test("renders capacity configuration in Worker and pool labels in Trigger labels", () => {
  const configuring = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "worker", worker: { ...worker, configurationState: "unconfigured" }, organizations: [], github: { appConfigured: true, organizationId: null, installation: null, repositories: [] }, pool: null, defaultImageDigest: "ubuntu@sha256:" + "b".repeat(64) });
  expect(configuring).toContain("GiB");
  expect(configuring).toContain("Configure resources");
  const labels = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "labels", worker, organizations: [], github: { appConfigured: true, organizationId: "org-1", installation: null, repositories: [] }, pool: null, defaultImageDigest: "ubuntu@sha256:" + "b".repeat(64) });
  expect(labels).toContain("Trigger label");
  expect(labels).toContain("runs-on:");
  expect(labels).toContain("whitesmith-linux-x64");
  expect(labels).not.toContain("self-hosted");
});

test("defaults each pool to one canonical platform architecture label", () => {
  for (const platform of ["linux-x64", "windows-x64", "macos-arm64"] as const) {
    const html = markup({
      version: 1,
      onboardingRequired: true,
      adminCreated: true,
      authenticated: true,
      canManage: true,
      step: "labels",
      worker: { ...worker, platform, limits: { maxVcpuPerPod: 2, maxMemoryBytesPerPod: 4_294_967_296, maxStorageBytesPerPod: 10_737_418_240, maxConcurrentPods: 1 } },
      organizations: [],
      github: { appConfigured: true, organizationId: "org-1", installation: null, repositories: [] },
      pool: null,
      defaultImageDigests: { [platform]: `job@sha256:${"b".repeat(64)}` },
      defaultImageDigest: null,
    });
    expect(html).toContain(`runs-on: ${`whitesmith-${platform}`}`);
    expect(html).not.toContain("self-hosted");
  }
});

test("complete state summarizes available repositories and offers workflow setup", () => {
  const html = markup({ version: 1, onboardingRequired: false, adminCreated: true, authenticated: true, canManage: true, step: "complete", worker, organizations: [{ id: "org-1", name: "Acme", login: "acme", repositoryCount: 1, workerCount: 1 }], github: { appConfigured: true, organizationId: "org-1", installation: null, repositories: [{ id: "repo-1", name: "private", fullName: "acme/private", visibility: "private", available: true }] }, pool: { id: "pool-1", name: "default", triggerLabel: "whitesmith-default", labels: ["self-hosted", "linux", "x64", "whitesmith-default"] }, defaultImageDigest: "ubuntu@sha256:" + "c".repeat(64) });
  expect(html).toContain("Onboarding complete");
  expect(html).toContain("Available repositories: 1");
  expect(html).toContain("Use Whitesmith runners");
  expect(html).toContain("Open dashboard");
});
