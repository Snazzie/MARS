import { expect, test } from "bun:test";
import { GithubJobsClient } from "./github-jobs.ts";

test("generates repository-scoped JIT config with labels", async () => {
  const requests: Request[] = [];
  const client = new GithubJobsClient({ token: async () => "installation-token", fetch: async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ encoded_jit_config: "secret-config" });
  }});
  const result = await client.generateJitConfig({ owner: "acme", repo: "project", runnerName: "ws-1", runnerGroupId: 7, workFolder: "_work", labels: ["self-hosted", "macos", "arm64", "whitesmith-default"] });
  expect(result.encodedJitConfig).toBe("secret-config");
  expect(requests[0].url).toBe("https://api.github.com/repos/acme/project/actions/runners/generate-jitconfig");
  expect(await requests[0].json()).toEqual({ name: "ws-1", runner_group_id: 7, work_folder: "_work", labels: ["self-hosted", "macos", "arm64", "whitesmith-default"] });
  expect(requests[0].headers.get("authorization")).toBe("Bearer installation-token");
});

test("does not hide a missing JIT config response", async () => {
  const client = new GithubJobsClient({ token: async () => "token", fetch: async () => Response.json({}) });
  await expect(client.generateJitConfig({ owner: "acme", repo: "project", runnerName: "ws-1", runnerGroupId: 1, workFolder: "_work", labels: ["self-hosted"] })).rejects.toThrow("github_jit_config_missing");
});
