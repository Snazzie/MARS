import { SecretBox } from "./auth.ts";
import { expect, test, spyOn } from "bun:test";
import { LlmProvidersService, generatePipelineAnalysis, generatePrReview, sanitizeProviderText, validateProviderApiRoot, type LlmProviderConfig } from "./llm-providers.ts";
import type { LLMLoadModelConfig } from "@lmstudio/sdk";

const context = { run: { workflow: "test", attempt: 1 }, failedJobs: [{ jobId: 42, steps: [{ stepNumber: 3, name: "assert", excerpt: "AssertionError: expected 2 but got 3" }] }] };
const valid = { summary: "Assertion failed", failures: [{ jobId: 42, stepNumber: 3, explanation: "The expected value differs.", evidence: ["expected 2 but got 3"], suggestedFix: "Update the expected value." }] };

function studioPrediction(content: string) {
  return Object.assign(Promise.resolve({ content, nonReasoningContent: content, stats: { stopReason: "eosFound" as const, promptTokensCount: 100, predictedTokensCount: 10 } }), {
    async *[Symbol.asyncIterator]() {
      yield { content, tokensCount: 10, containsDrafted: false, reasoningType: "none" as const, isStructural: false };
    },
  });
}

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
  expect(usage).toMatchObject([{ inputTokens: 17, outputTokens: 8 }]);

  await generatePipelineAnalysis({ provider: { ...provider, kind: "anthropic", encryptedApiKey: "api-key" }, context, onUsage: value => { usage.push(value); } }, async () => Response.json({
    content: [{ type: "text", text: JSON.stringify(valid) }],
    usage: { input_tokens: 23, output_tokens: 9, cache_read_input_tokens: 4 },
  }));
  expect(usage[1]).toMatchObject({ inputTokens: 27, outputTokens: 9 });
});

test("captures reported usage before rejecting invalid generated JSON and ignores invalid counts", async () => {
  const provider = { name: "local", kind: "openai-compatible" as const, baseUrl: "http://localhost:11434/v1", model: "model" };
  const usage: Array<{ inputTokens: number; outputTokens: number } | null> = [];
  await expect(generatePipelineAnalysis({ provider, context, onUsage: value => { usage.push(value); } }, async () => Response.json({
    choices: [{ message: { content: "not JSON" } }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  }))).rejects.toThrow("llm_invalid_response");
  expect(usage).toMatchObject([{ inputTokens: 12, outputTokens: 3 }]);

  await generatePipelineAnalysis({ provider, context, onUsage: value => { usage.push(value); } }, async () => Response.json({
    choices: [{ message: { content: JSON.stringify(valid) } }],
    usage: { prompt_tokens: -1, completion_tokens: 3 },
  }));
  expect(usage[1]).toBeNull();
});

test("pipeline analysis accepts three evidence excerpts without truncation and rejects a fourth", async () => {
  const provider: LlmProviderConfig = { name: "local", kind: "openai-compatible", baseUrl: "http://localhost/v1", model: "model" };
  const evidence = ["First assertion failed", "Expected value was 2", "Actual value was 3"];
  const result = { ...valid, failures: [{ ...valid.failures[0]!, evidence }] };
  expect(await generatePipelineAnalysis({ provider, context }, async () => Response.json({
    choices: [{ message: { content: JSON.stringify(result) } }],
  }))).toEqual(result);
  const oversized = { ...result, failures: [{ ...result.failures[0]!, evidence: [...evidence, "Fourth excerpt"] }] };
  await expect(generatePipelineAnalysis({ provider, context }, async () => Response.json({
    choices: [{ message: { content: JSON.stringify(oversized) } }],
  }))).rejects.toThrow("llm_invalid_response");
});

test("throughput uses output tokens and includes response body time but excludes request bookkeeping", async () => {
  let clock = 0;
  const timer = spyOn(performance, "now").mockImplementation(() => clock);
  const usage: unknown[] = [];
  try {
    await generatePipelineAnalysis({
      provider: { name: "local", kind: "openai-compatible", baseUrl: "http://localhost/v1", model: "model" },
      context,
      onRequest: () => { clock = 5000; },
      onUsage: value => { usage.push(value); },
    }, async () => {
      clock = 5500;
      return new Response(new ReadableStream({
        pull(controller) {
          clock = 7000;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(valid) } }],
            usage: { prompt_tokens: 1000, completion_tokens: 40 },
          })));
          controller.close();
        },
      }));
    });
    expect(usage).toEqual([{ inputTokens: 1000, outputTokens: 40, tokensPerSecond: 20 }]);
  } finally { timer.mockRestore(); }
});

test("PR review retains throughput when generated findings are invalid", async () => {
  let clock = 0;
  const timer = spyOn(performance, "now").mockImplementation(() => clock);
  const usage: unknown[] = [];
  try {
    await expect(generatePrReview({
      provider: { name: "cloud", kind: "anthropic", baseUrl: "http://localhost/v1", model: "model", encryptedApiKey: "key" },
      context: {},
      onUsage: value => { usage.push(value); },
    }, async () => {
      clock = 2000;
      return Response.json({ content: [{ type: "text", text: "invalid JSON" }], usage: { input_tokens: 100, output_tokens: 30 } });
    })).rejects.toThrow("llm_invalid_response");
    expect(usage).toEqual([{ inputTokens: 100, outputTokens: 30, tokensPerSecond: 15 }]);
  } finally { timer.mockRestore(); }
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
  let config: LLMLoadModelConfig = {};
  const studioClientFactory: NonNullable<Parameters<typeof generatePipelineAnalysis>[0]["studioClientFactory"]> = () => ({
    llm: { model: async (_key, options) => {
      if (!loaded) { loads++; loaded = true; config = options.config ?? {}; }
      return { identifier: "instance-1", getLoadConfig: async () => config, getContextLength: async () => 16384, applyPromptTemplate: async history => JSON.stringify(history), countTokens: async text => text.length, respond: () => studioPrediction(JSON.stringify(valid)) };
    } },
    async [Symbol.asyncDispose]() {},
  });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer studio-key") return new Response(null, { status: 401 });
      const path = new URL(request.url).pathname;
      if (path === "/proxy/api/v1/models") return Response.json({ models: [
        { type: "llm", key: "downloaded-model", loaded_instances: loaded ? [{ id: "instance-1" }] : [] },
      ] });
      return new Response(null, { status: 404 });
    },
  });
  const provider: LlmProviderConfig = { name: "Studio", kind: "lm-studio", baseUrl: `${server.url}proxy/v1`, model: "downloaded-model", encryptedApiKey: "studio-key" };
  try {
    expect(await generatePipelineAnalysis({ provider, context, studioClientFactory })).toEqual(valid);
    expect(loads).toBe(1);
    expect(await generatePipelineAnalysis({ provider, context, studioClientFactory })).toEqual(valid);
    expect(loads).toBe(1);
    expect(await generatePipelineAnalysis({ provider: { ...provider, model: "instance-1" }, context, studioClientFactory })).toEqual(valid);
    expect(loads).toBe(1);
    loaded = false;
    expect(await generatePipelineAnalysis({ provider, context, studioClientFactory })).toEqual(valid);
    expect(loads).toBe(2);
  } finally { server.stop(true); }
});

test("LM Studio refuses missing and non-LLM selections before inference", async () => {
  const provider: LlmProviderConfig = { name: "Studio", kind: "lm-studio", baseUrl: "http://studio.test/v1", model: "model" };
  const scenarios = [
    { models: [], error: "llm_model_not_found" },
    { models: [{ type: "embedding", key: "model", loaded_instances: [] }], error: "llm_model_not_found" },
  ];
  for (const scenario of scenarios) {
    let inferenceCalls = 0;
    await expect(generatePipelineAnalysis({ provider, context }, async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/chat/completions")) { inferenceCalls++; return Response.json({}); }
      return Response.json({ models: scenario.models });
    })).rejects.toThrow(scenario.error);
    expect(inferenceCalls).toBe(0);
  }
});

test.each(["partial", "cpu-experts", "vram-cap", "engine-error"])("LM Studio rejects %s instead of silently generating without full GPU offload", async mode => {
  const provider: LlmProviderConfig = { name: "Studio", kind: "lm-studio", baseUrl: "http://studio.test/v1", model: "model" };
  let inferenceCalls = 0;
  const studioClientFactory: NonNullable<Parameters<typeof generatePipelineAnalysis>[0]["studioClientFactory"]> = () => ({
    llm: { model: async () => {
      if (mode === "engine-error") throw new Error("private engine failure");
      return { identifier: "model", getLoadConfig: async () => ({ gpu: { ratio: mode === "partial" ? 0.5 : 1, numCpuExpertLayersRatio: mode === "cpu-experts" ? 0.5 : "off" }, gpuStrictVramCap: mode === "vram-cap" }), getContextLength: async () => 16384, applyPromptTemplate: async history => JSON.stringify(history), countTokens: async text => text.length, respond: () => { inferenceCalls++; return studioPrediction(JSON.stringify(valid)); } };
    } },
    async [Symbol.asyncDispose]() {},
  });
  await expect(generatePipelineAnalysis({ provider, context, studioClientFactory }, async input => {
    if (new URL(String(input)).pathname.endsWith("/chat/completions")) { inferenceCalls++; return Response.json({}); }
    return Response.json({ models: [{ type: "llm", key: "model", loaded_instances: [{ id: "model" }] }] });
  })).rejects.toThrow("llm_model_load_failed");
  expect(inferenceCalls).toBe(0);
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
test("generates structured PR findings through the shared provider transport and records usage", async () => {
  const provider = { name: "cloud", kind: "openai-compatible" as const, baseUrl: "http://localhost:11434/v1", model: "model", encryptedApiKey: "review-secret" };
  const usage: Array<{ inputTokens: number; outputTokens: number } | null> = [];
  const finding = { path: "src/a.ts", line: 3, endLine: null, severity: "High" as const, confidencePercent: 82, evidence: "unsafe call", impact: "Input leaks.", correction: "Validate input.", suggestion: null };
  const result = await generatePrReview({
    provider, context: { pullRequest: { headSha: "abc", title: "review-secret" }, files: [{ path: "src/a.ts", source: "unsafe call()" }] },
    onUsage: value => { usage.push(value); },
  }, async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    expect(request.messages[1].content).not.toContain("review-secret");
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [finding] }) } }], usage: { prompt_tokens: 14, completion_tokens: 7 } });
  });
  expect(result.findings).toEqual([finding]);
  expect(usage).toMatchObject([{ inputTokens: 14, outputTokens: 7 }]);
});
test("preserves PR eligibility aborts instead of reporting them as provider failures", async () => {
  const provider = { name: "cloud", kind: "openai-compatible" as const, baseUrl: "http://localhost:11434/v1", model: "model" };
  await expect(generatePrReview({
    provider, context: {}, onRequest: async () => { throw new Error("pr_review_superseded"); },
  }, async () => { throw new Error("provider should not be called"); })).rejects.toThrow("pr_review_superseded");
});

test("rejects invalid structured PR findings without relaxing provider output validation", async () => {
  const provider = { name: "cloud", kind: "openai-compatible" as const, baseUrl: "http://localhost:11434/v1", model: "model" };
  await expect(generatePrReview({ provider, context: {} }, async () => Response.json({ choices: [{ message: { content: '{"findings":[{"confidencePercent":60}]}' } }] }))).rejects.toThrow("llm_invalid_response");
});

test.each([undefined, null, 59.5, -1, 101, "85"])("invalid PR confidence %p cannot become a publishable result", async confidencePercent => {
  const provider: LlmProviderConfig = { name: "cloud", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "model" };
  const finding = { path: "calc.ts", line: 1, endLine: null, severity: "High", confidencePercent, evidence: "n / 0", impact: "Division by zero.", correction: "Use the denominator.", suggestion: null };
  await expect(generatePrReview({ provider, context: {} }, async () => Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [finding] }) } }] }))).rejects.toThrow("llm_invalid_response");
});

test.each([8192, 4100])("PR reviews respect the loaded %p-token context and preserve immutable evidence", async contextLength => {
  const source = {
    pullRequest: { number: 7, title: "Review", description: "description".repeat(1000), baseSha: "a".repeat(40), headSha: "b".repeat(40) },
    rules: { path: ".mars/pr-rules.md" as const, baseSha: "a".repeat(40), blobSha: null, status: "missing" as const, text: null },
    files: [1, 2].map(number => ({ path: `file${number}.ts`, status: "modified", patch: "@@ -1 +1 @@\n-old\n+new", headSource: "new".repeat(500), coverage: "reviewable" as const, changedLines: [1], diffPositions: { 1: 1 }, hunkIds: { 1: 0 } })),
    coverage: { changedFiles: 2, consideredFiles: 2, reviewableFiles: 2, omittedFiles: 0, complete: true, limitations: [] as string[] },
  };
  let submitted = false;
  let captured: typeof source | undefined;
  const studioClientFactory: NonNullable<Parameters<typeof generatePrReview>[0]["studioClientFactory"]> = () => ({
    llm: { model: async () => ({
      identifier: "model",
      getLoadConfig: async () => ({ gpu: { ratio: 1, numCpuExpertLayersRatio: "off" }, gpuStrictVramCap: false, autoFit: false }),
      getContextLength: async () => contextLength,
      applyPromptTemplate: async chat => JSON.stringify(chat),
      countTokens: async text => text.length,
      respond: (history, options) => {
        submitted = true;
        if (JSON.stringify(history).length + Number(options.maxTokens) > contextLength) throw new Error("oversized prompt submitted");
        const context = captured!;
        expect(context.files.map(file => file.path)).toEqual(["file1.ts"]);
        expect(context.files[0]!.headSource).toBe(source.files[0]!.headSource);
        expect(context.rules).toEqual(source.rules);
        expect(context.coverage).toMatchObject({ complete: false, reviewableFiles: 1, omittedFiles: 1 });
        return studioPrediction('{"findings":[]}');
      },
    }) },
    async [Symbol.asyncDispose]() {},
  });
  const run = generatePrReview({
    provider: { name: "Studio", kind: "lm-studio", baseUrl: "http://studio.test/v1", model: "model" },
    context: source, studioClientFactory,
    onContext: context => { captured = context as typeof source; },
  }, async () => Response.json({ models: [{ type: "llm", key: "model", loaded_instances: [{ id: "model" }] }] }));
  if (contextLength === 4100) {
    await expect(run).rejects.toThrow("pr_review_context_too_large");
    expect(submitted).toBe(false);
    expect(captured).toBeUndefined();
  } else {
    expect(await run).toEqual({ findings: [] });
    expect(captured?.files.map(file => file.path)).toEqual(["file1.ts"]);
    expect(source.files).toHaveLength(2);
    expect(source.pullRequest.description).not.toBeNull();
  }
});

test("LM Studio publishes live input and output usage before generation finishes, then reconciles totals", async () => {
  const release = Promise.withResolvers<void>(), live = Promise.withResolvers<void>();
  let clock = 0;
  const timer = spyOn(performance, "now").mockImplementation(() => clock);
  const usages: Array<{ inputTokens: number; outputTokens: number; tokensPerSecond: number | null } | null> = [];
  const content = JSON.stringify(valid);
  let completed = false;
  const factory: NonNullable<Parameters<typeof generatePipelineAnalysis>[0]["studioClientFactory"]> = () => ({
    llm: { model: async () => ({
      identifier: "model", getLoadConfig: async () => ({ gpu: { ratio: 1, numCpuExpertLayersRatio: "off" }, gpuStrictVramCap: false, autoFit: false }),
      getContextLength: async () => 8192, applyPromptTemplate: async () => "rendered prompt", countTokens: async () => 12,
      respond: () => Object.assign(release.promise.then(() => ({ content, nonReasoningContent: content, stats: { stopReason: "eosFound" as const, promptTokensCount: 13, predictedTokensCount: 10, tokensPerSecond: 8 } })), {
        async *[Symbol.asyncIterator]() {
          clock = 1000;
          yield { content: content.slice(0, 10), tokensCount: 4, containsDrafted: false, reasoningType: "none" as const, isStructural: false };
          await release.promise;
          clock = 2000;
          yield { content: content.slice(10), tokensCount: 5, containsDrafted: false, reasoningType: "none" as const, isStructural: false };
        },
      }),
    }) }, async [Symbol.asyncDispose]() {},
  });
  try {
    const run = generatePipelineAnalysis({
      provider: { name: "Studio", kind: "lm-studio", baseUrl: "http://studio.test/v1", model: "model" },
      context, studioClientFactory: factory,
      onUsage: usage => { usages.push(usage); if (usage?.outputTokens === 4) live.resolve(); },
    }, async () => Response.json({ models: [{ type: "llm", key: "model", loaded_instances: [{ id: "model" }] }] })).then(result => { completed = true; return result; });
    await live.promise;
    expect(completed).toBe(false);
    expect(usages).toEqual([{ inputTokens: 12, outputTokens: 0, tokensPerSecond: null }, { inputTokens: 12, outputTokens: 4, tokensPerSecond: 4 }]);
    release.resolve();
    expect(await run).toEqual(valid);
    expect(usages.at(-1)).toEqual({ inputTokens: 13, outputTokens: 10, tokensPerSecond: 8 });
  } finally { release.resolve(); timer.mockRestore(); }
});

test("Anthropic streaming merges cached input usage and rejects truncated output", async () => {
  const usages: unknown[] = [];
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: JSON.stringify(valid) } },
    { type: "message_delta", usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
  const provider: LlmProviderConfig = { name: "Cloud", kind: "anthropic", baseUrl: "http://cloud.test/v1", model: "model", encryptedApiKey: "key" };
  const fetcher = async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  expect(await generatePipelineAnalysis({ provider, context, onUsage: usage => { usages.push(usage); } }, fetcher)).toEqual(valid);
  expect(usages).toMatchObject([{ inputTokens: 15, outputTokens: 0 }, { inputTokens: 15, outputTokens: 7 }]);
  events.pop();
  await expect(generatePipelineAnalysis({ provider, context }, fetcher)).rejects.toThrow("llm_invalid_response");
});
