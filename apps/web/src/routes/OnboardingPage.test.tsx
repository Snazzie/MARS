import { expect, test } from "bun:test";
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

function markup(detail: Record<string, unknown>) {
  const client = new QueryClient();
  client.setQueryData(["onboarding-status"], detail);
  client.setQueryData(["onboarding"], detail);
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

test("resources step marks completed steps, current resources, locked labels, and saved status", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "resources", worker, organizations: [], github: { appConfigured: true, organizationId: "org-1", installation: null, repositories: [] }, pool: null, defaultImageDigest: "ubuntu@sha256:" + "a".repeat(64) });
  for (const [label, className] of [["Admin", "is-complete"], ["Worker", "is-complete"], ["GitHub", "is-complete"], ["Resources", "is-current"], ["Trigger labels", "is-locked"]]) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const element = html.match(new RegExp(`<li[^>]*>[^<]*<span>[^<]*</span><strong>${escaped}</strong></li>`))?.[0] ?? "";
    expect(element).toContain(className);
  }
  expect(html).toContain("Progress is saved");
  expect(html).toContain("Configure resources");
});

test("completed steps render review summaries without mutation controls", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "resources", worker, organizations: [{ id: "org-1", name: "Acme", login: "acme", repositoryCount: 1, workerCount: 1 }], github: { appConfigured: true, organizationId: "org-1", installation: { id: "inst-1", githubInstallationId: 42, state: "approved", repositorySelection: "selected" }, repositories: [{ id: "repo-1", name: "private", visibility: "private", available: true, approved: true }] }, pool: null, defaultImageDigest: "ubuntu@sha256:" + "a".repeat(64) });
  expect(html).toContain("linux-builder");
  expect(html).toContain("Acme");
  expect(html).toContain("private");
  expect(html).not.toMatch(/<button\b/);
  expect(html).not.toMatch(/<form\b/);
});

test("admin and sign-in states expose the appropriate GitHub action", () => {
  expect(markup({ version: 1, onboardingRequired: true, adminCreated: false, authenticated: false, canManage: false, step: "admin" })).toContain("Create administrator with GitHub");
  expect(markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: false, canManage: false, step: "admin" })).toContain("Sign in with GitHub");
});

test("renders five-step progress with only the server current step enabled", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "resources", worker, organizations: [], github: { appConfigured: true, organizationId: "org-1", installation: null, repositories: [] }, pool: null, defaultImageDigest: "ubuntu@sha256:" + "a".repeat(64) });
  for (const label of ["Admin", "Worker", "GitHub", "Resources", "Trigger labels"]) expect(html).toContain(label);
  expect(html).toContain("Configure resources");
  expect(html).toContain("Worker enrollment");
  expect(html).toContain("GitHub organization");
});

test("exposes explicit worker selection and selected private/internal repository controls", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "github", worker: null, organizations: [{ id: "org-1", name: "Acme", login: "acme", repositoryCount: 2, workerCount: 1 }], github: { appConfigured: true, organizationId: "org-1", installation: { id: "inst-1", githubInstallationId: 42, state: "approved", repositorySelection: "selected" }, repositories: [{ id: "repo-1", name: "private", visibility: "private", available: true, approved: false }, { id: "repo-2", name: "public", visibility: "public", available: true, approved: false }] }, pool: null, defaultImageDigest: null });
  expect(html).toContain("Use this worker");
  expect(html).toContain("private");
  expect(html).not.toContain('name="repo-2"');
  expect(html).toContain("Approve repositories");
});

test("renders GiB resource inputs, configuring acknowledgement state, and trigger labels", () => {
  const html = markup({ version: 1, onboardingRequired: true, adminCreated: true, authenticated: true, canManage: true, step: "labels", worker, organizations: [], github: { appConfigured: true, organizationId: "org-1", installation: null, repositories: [] }, pool: null, defaultImageDigest: "ubuntu@sha256:" + "b".repeat(64) });
  expect(html).toContain("GiB");
  expect(html).toContain("Configuring worker");
  expect(html).toContain("Trigger label");
  expect(html).toContain("runs-on:");
  expect(html).toContain("whitesmith-default");
});

test("complete state summarizes organization, repositories, worker, pool, and dashboard link", () => {
  const html = markup({ version: 1, onboardingRequired: false, adminCreated: true, authenticated: true, canManage: true, step: "complete", worker, organizations: [{ id: "org-1", name: "Acme", login: "acme", repositoryCount: 1, workerCount: 1 }], github: { appConfigured: true, organizationId: "org-1", installation: null, repositories: [{ id: "repo-1", name: "private", visibility: "private", available: true, approved: true }] }, pool: { id: "pool-1", name: "default", triggerLabel: "whitesmith-default", labels: ["self-hosted", "linux", "x64", "whitesmith-default"] }, defaultImageDigest: "ubuntu@sha256:" + "c".repeat(64) });
  expect(html).toContain("Onboarding complete");
  expect(html).toContain("Open dashboard");
});
