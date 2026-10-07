import { SecretBox } from "./auth.ts";
import { expect, test } from "bun:test";
import { LlmProvidersService, generatePipelineAnalysis, sanitizeProviderText, validateProviderApiRoot, type LlmProviderConfig } from "./llm-providers.ts";

const context = { run: { workflow: "test", attempt: 1 }, failedJobs: [{ jobId: 42, steps: [{ stepNumber: 3, name: "assert", excerpt: "AssertionError: expected 2 but got 3" }] }] };
const valid = { summary: "Assertion failed", failures: [{ jobId: 42, stepNumber: 3, explanation: "The expected value differs.", evidence: ["expected 2 but got 3"], suggestedFix: "Update the expected value." }] };

test("validates API roots and rejects URL credentials, query, fragment, and non-HTTP schemes", () => {
  expect(validateProviderApiRoot("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
  for (const value of ["file:///tmp", "https://user:pass@example.com/v1", "https://example.com/v1?x=1", "https://example.com/v1#frag"]) expect(() => validateProviderApiRoot(value)).toThrow();
});

test("sanitizes configured keys and credential-shaped log material", () => {
  const cleaned = sanitizeProviderText("API_KEY=smoke-secret-do-not-disclose\nBearer ghp_123456789012345678901234567890123456\npassword: hunter2", "smoke-secret-do-not-disclose");
  expect(cleaned).not.toContain("smoke-secret-do-not-disclose");
  expect(cleaned).not.toContain("ghp_123456789012345678901234567890123456");
  expect(cleaned).not.toContain("hunter2");
});

test("sends a keyless OpenAI-compatible request and validates captured job and step IDs", async () => {
  let sent: Request | undefined;
  const result = await generatePipelineAnalysis({ provider: { name: "local", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "model" }, context }, async (input, init) => {
    sent = new Request(input, init);
    return Response.json({ choices: [{ message: { content: JSON.stringify(valid) } }] });
  });
  expect(result).toEqual(valid);
  expect(sent?.headers.get("authorization")).toBeNull();
  expect(JSON.parse(await sent!.text())).toMatchObject({ model: "model", max_tokens: 4096 });
  await expect(generatePipelineAnalysis({ provider: { name: "local", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "model" }, context }, async () => Response.json({ choices: [{ message: { content: JSON.stringify({ ...valid, failures: [{ ...valid.failures[0], jobId: 999 }] }) } }] }))).rejects.toThrow("llm_invalid_response");
});

test("parses native Anthropic text blocks and requires a key", async () => {
  const result = await generatePipelineAnalysis({ provider: { name: "cloud", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "model", encryptedApiKey: "api-key" }, context }, async (_input, init) => {
    expect(new Headers(init?.headers).get("x-api-key")).toBe("api-key");
    expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
    return Response.json({ content: [{ type: "text", text: JSON.stringify(valid) }] });
  });
  expect(result.summary).toBe("Assertion failed");
  await expect(generatePipelineAnalysis({ provider: { name: "cloud", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "model" }, context }, async () => Response.json({}))).rejects.toThrow("llm_auth_failed");
});

test("rejects malformed provider response with a bounded code", async () => {
  const provider = { name: "local", kind: "openai-compatible" as const, baseUrl: "http://localhost:11434/v1", model: "model" };
  await expect(generatePipelineAnalysis({ provider, context }, async () => Response.json({ choices: [{ message: { content: "not JSON" } }] }))).rejects.toThrow("llm_invalid_response");
});

test("encrypts saved API keys and never returns key material in provider summaries", async () => {
  const box = new SecretBox(Buffer.alloc(32, 5).toString("base64"));
  const stored: LlmProviderConfig[] = [];
  const store = {
    list: async () => stored,
    get: async () => stored[0] ?? null,
    save: async (input: LlmProviderConfig) => { const provider = { ...input, id: "provider-1" }; stored.splice(0, 1, provider); return provider; },
    delete: async () => { stored.length = 0; },
  };
  const service = new LlmProvidersService(box, store);
  const summary = await service.save({ name: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.test/v1", model: "model", apiKey: "cloud-secret" });
  expect(stored[0]?.encryptedApiKey).not.toBe("cloud-secret");
  expect(box.decrypt(stored[0]!.encryptedApiKey!)).toBe("cloud-secret");
  expect(summary).toEqual({ id: "provider-1", name: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.test/v1", model: "model", keyConfigured: true });
});

test("blank API roots save concrete provider defaults", async () => {
  const box = new SecretBox(Buffer.alloc(32, 5).toString("base64"));
  const service = new LlmProvidersService(box, {
    list: async () => [], get: async () => null, delete: async () => {},
    save: async (input) => ({ ...input, id: "provider-1" }),
  });
  expect((await service.save({ name: "local", kind: "openai-compatible", baseUrl: "  ", model: "model" })).baseUrl).toBe("http://localhost:11434/v1");
  expect((await service.save({ name: "cloud", kind: "anthropic", baseUrl: "", model: "model", apiKey: "key" })).baseUrl).toBe("https://api.anthropic.com/v1");
});

test("model lookup deduplicates results and never sends a retained key to a changed root", async () => {
  const box = new SecretBox(Buffer.alloc(32, 5).toString("base64"));
  const authorization: Array<string | null> = [];
  const service = new LlmProvidersService(box, {
    list: async () => [],
    get: async () => ({ name: "local", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "model", encryptedApiKey: box.encrypt("saved-secret") }),
    save: async (input) => input, delete: async () => {},
  }, async (_input, init) => {
    authorization.push(new Headers(init?.headers).get("authorization"));
    return Response.json({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-b" }] });
  });
  expect(await service.models({ baseUrl: "", providerId: "profile" })).toEqual(["model-a", "model-b"]);
  await service.models({ baseUrl: "http://localhost:1234/v1", providerId: "profile" });
  await service.models({ baseUrl: "", providerId: "profile", apiKey: null });
  expect(authorization).toEqual(["Bearer saved-secret", null, null]);
});

test("model lookup rejects malformed listings without exposing provider response bodies", async () => {
  const service = new LlmProvidersService(new SecretBox(Buffer.alloc(32, 5).toString("base64")), {
    list: async () => [], get: async () => null, save: async (input) => input, delete: async () => {},
  }, async () => new Response("secret internal provider error"));
  await expect(service.models({ baseUrl: "" })).rejects.toThrow("llm_invalid_response");
});
