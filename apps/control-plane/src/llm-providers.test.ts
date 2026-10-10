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

test("captures OpenAI-compatible and Anthropic reported token usage", async () => {
  const provider = { name: "cloud", kind: "openai-compatible" as const, baseUrl: "http://localhost:11434/v1", model: "model" };
  const usage: Array<{ inputTokens: number; outputTokens: number } | null> = [];
  await generatePipelineAnalysis({ provider, context, onUsage: value => { usage.push(value); } }, async () => Response.json({
    choices: [{ message: { content: JSON.stringify(valid) } }],
    usage: { prompt_tokens: 17, completion_tokens: 8 },
  }));
  expect(usage).toEqual([{ inputTokens: 17, outputTokens: 8 }]);

  await generatePipelineAnalysis({ provider: { ...provider, kind: "anthropic", encryptedApiKey: "api-key" }, context, onUsage: value => { usage.push(value); } }, async () => Response.json({
    content: [{ type: "text", text: JSON.stringify(valid) }],
    usage: { input_tokens: 23, output_tokens: 9, cache_read_input_tokens: 4 },
  }));
  expect(usage[1]).toEqual({ inputTokens: 27, outputTokens: 9 });
});

test("captures reported usage before rejecting invalid generated JSON and ignores invalid counts", async () => {
  const provider = { name: "local", kind: "openai-compatible" as const, baseUrl: "http://localhost:11434/v1", model: "model" };
  const usage: Array<{ inputTokens: number; outputTokens: number } | null> = [];
  await expect(generatePipelineAnalysis({ provider, context, onUsage: value => { usage.push(value); } }, async () => Response.json({
    choices: [{ message: { content: "not JSON" } }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  }))).rejects.toThrow("llm_invalid_response");
  expect(usage).toEqual([{ inputTokens: 12, outputTokens: 3 }]);

  await generatePipelineAnalysis({ provider, context, onUsage: value => { usage.push(value); } }, async () => Response.json({
    choices: [{ message: { content: JSON.stringify(valid) } }],
    usage: { prompt_tokens: -1, completion_tokens: 3 },
  }));
  expect(usage[1]).toBeNull();
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
  expect(summary.keyConfigured).toBe(true);
  expect(summary).not.toHaveProperty("encryptedApiKey");
  expect(JSON.stringify(summary)).not.toContain("cloud-secret");
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

test("LM Studio cold-loads once, reuses its instance, and reloads after eviction", async () => {
  let loaded = false;
  let loads = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer studio-key") return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === "/proxy/api/v1/models") return Response.json({ models: [
        { type: "llm", key: "downloaded-model", loaded_instances: loaded ? [{ id: "instance-1" }] : [] },
      ] });
      if (path === "/proxy/api/v1/models/load") {
        const body = await request.json();
        if (body.model !== "downloaded-model") return new Response(null, { status: 400 });
        loads++; loaded = true;
        return Response.json({ type: "llm", status: "loaded", instance_id: "instance-1" });
      }
      if (path === "/proxy/v1/chat/completions") {
        const body = await request.json();
        if (!loaded || body.model !== "instance-1") return new Response(null, { status: 400 });
        return Response.json({ choices: [{ message: { content: JSON.stringify(valid) } }] });
      }
      return new Response(null, { status: 404 });
    },
  });
  const provider: LlmProviderConfig = { name: "Studio", kind: "lm-studio", baseUrl: `${server.url}proxy/v1`, model: "downloaded-model", encryptedApiKey: "studio-key" };
  try {
    expect(await generatePipelineAnalysis({ provider, context })).toEqual(valid);
    expect(loads).toBe(1);
    expect(await generatePipelineAnalysis({ provider, context })).toEqual(valid);
    expect(loads).toBe(1);
    expect(await generatePipelineAnalysis({ provider: { ...provider, model: "instance-1" }, context })).toEqual(valid);
    expect(loads).toBe(1);
    loaded = false;
    expect(await generatePipelineAnalysis({ provider, context })).toEqual(valid);
    expect(loads).toBe(2);
  } finally { server.stop(true); }
});

test("LM Studio refuses missing, non-LLM, failed, and malformed loads before inference", async () => {
  const provider: LlmProviderConfig = { name: "Studio", kind: "lm-studio", baseUrl: "http://studio.test/v1", model: "model" };
  const scenarios = [
    { models: [], load: {}, status: 200, error: "llm_model_not_found" },
    { models: [{ type: "embedding", key: "model", loaded_instances: [] }], load: {}, status: 200, error: "llm_model_not_found" },
    { models: [{ type: "llm", key: "model", loaded_instances: [] }], load: { secret: "private failure" }, status: 500, error: "llm_model_load_failed" },
    { models: [{ type: "llm", key: "model", loaded_instances: [] }], load: {}, status: 401, error: "llm_auth_failed" },
    { models: [{ type: "llm", key: "model", loaded_instances: [] }], load: { type: "llm", status: "loading", instance_id: "model" }, status: 200, error: "llm_invalid_response" },
  ];
  for (const scenario of scenarios) {
    let inferenceCalls = 0;
    await expect(generatePipelineAnalysis({ provider, context }, async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/chat/completions")) { inferenceCalls++; return Response.json({}); }
      if (path.endsWith("/load")) return Response.json(scenario.load, { status: scenario.status });
      return Response.json({ models: scenario.models });
    })).rejects.toThrow(scenario.error);
    expect(inferenceCalls).toBe(0);
  }
});

test("LM Studio model discovery includes unloaded LLMs but excludes embedding and decision models", async () => {
  const service = new LlmProvidersService(new SecretBox(Buffer.alloc(32, 5).toString("base64")), {
    list: async () => [], get: async () => null, save: async (input) => input, delete: async () => {},
  }, async () => Response.json({ models: [
    { type: "llm", key: "unloaded", loaded_instances: [] },
    { type: "embedding", key: "embedding", loaded_instances: [] },
    { type: "decision", key: "decision", loaded_instances: [] },
    { type: "llm", key: "loaded", loaded_instances: [{ id: "instance" }] },
  ] }));
  expect(await service.models({ kind: "lm-studio", baseUrl: "" })).toEqual(["loaded", "unloaded"]);
});
