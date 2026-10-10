# AI Pull Request Review Implementation Plan

Status: Code implemented; migrations, regression gates, typecheck, and the actual AI settings UI are verified. Live acceptance is pending: signed PR/command delivery requires the installed App subscriptions, and the saved reasoning model produced no final JSON within the approved ten-minute limit. The user approved switching the shared local profile to downloaded `google/gemma-4-e2b`; fresh real publication smoke is running with that choice.

Verification recorded so far:
- `bun run db:generate` produced `0011_blue_centennial.sql`; `bun run db:check` passed.
- `bun run db:migrate` passed for development and isolated `mars_pr_review_verify_20261010` PostgreSQL databases.
- Latest current-worktree Bun gate: 276 passed, 0 failed across 11 focused suites; this includes three new interruption-window cases and three concurrent user-owned comment-body cases. Workspace typecheck passed after the concurrent edit settled.
- `bun run typecheck` passed for all workspaces.
- Publication-state-write failure and historical usage-window loss were reproduced before their fixes; the earlier 270-test gate includes recovery without another model call/POST and combined PR/CI usage over the inclusive 30-day UTC window. An earlier broad run transiently failed the unrelated worker-artifact 10 ms cancellation assertion; that case passed in isolation and subsequent broad gates without a code change.
- The actual AI settings UI was exercised: separate source-sharing consent, saved provider selection, and PR opt-in persisted for the disposable repository.
- GPT-6 Luna (`openai-codex/gpt-6-luna`) owns the live PR/CI smoke loop. A real `/review` comment on PR #2 reached GitHub but no corresponding webhook or model call occurred because the installed App subscriptions are missing. This is not an end-to-end pass.
- A separately labeled direct-processor smoke accepted the real command and captured immutable rules/source, but the saved LM Studio `qwen3.8-27b` provider timed out. The actual settings UI shows `failed / pending`, `llm_timeout`, captured SHA, base rules/blob provenance, complete 1/1-file coverage, and unknown usage/cost. No GitHub review was published by that attempt.
- The first real controlled CI failure exposed a pre-existing identity mismatch: CI selected the local installation UUID, converted it to `NaN`, and requested `/app/installations/NaN/access_tokens`. Processing and unknown-comment recovery now select the numeric GitHub installation ID. A migrated regression failed before the fix and passes afterward. The fresh [CI run 38011948318](https://github.com/Snazzie/mars-pr-review-smoke-20261010/actions/runs/38011948318) received three real signed `workflow_job` deliveries and reached the provider after focused repository discovery, then failed with `llm_timeout` at 90.002 seconds; no diagnostic comment exists.
- A public arithmetic transport calibration returned HTTP 200 in 25.619 seconds, but consumed all 128 completion tokens as reasoning (`finish_reason: length`) with no final content. Saved and loaded model IDs match. This is diagnosis, not successful PR or CI proof; provider/global settings and generation deadlines were left unchanged.
- The disposable repository's main and PR-branch refs remained `6b31f427de3dd9c914b5f2d67b82521097eb22e3` and `10c4a84aec68bbde7dd6e7b7cb5bac34d4fd1c61` before/after attempted review. Author setup commits are separate from MARS review activity.
- The user selected **Allow longer generation**. Generation now allows 10 minutes; PR/CI interrupted-analysis cutoffs are 15 minutes. Model-loading and five-minute unknown-publication recovery limits, prompts, token caps, provider model, and global settings are unchanged. Failed revisions/attempts are not force-retried. Fresh CI run `38014784874` reached the provider but became `analysis_interrupted` after overlapping concurrent source edits; it is not evidence of a 600-second timeout and produced no comment.
- Concurrent user-owned diagnostic-body/schema changes were preserved. Their generated additive `0012_opposite_pet_avengers` migration was applied to the isolated and development databases before the fresh smoke processor continued.
- Fresh author revision `6e1afe5a21bd20b854bb0d91e14743b54e890c6b` reached the provider via the separately labeled direct handler and failed with `llm_unavailable` after 296.3 seconds. LM Studio logs show prompt processing complete, about 1,313 generated reasoning tokens, then client disconnect with no final content. Bun's omitted request-level socket-idle timeout defaults to five minutes, shorter than the approved whole-request deadline. Generation now explicitly sets the matching 600,000 ms socket-idle limit; no provider/model/prompt change was made.
- Actual Bun 1.4.0 localhost HTTP transport smoke with a 35-second delayed response: a one-second request-level idle limit failed with `llm_unavailable`; the fixed generation path received and validated the result after 35,003 ms. Initial three-second probes were too short to trigger the idle checker; they were not passing regression proof. This isolated HTTP fixture is not actual PR/CI publication. The focused 276-test gate passed, and all workspace typechecks passed after the transport typing correction.
- Read-only App hook inspection found the configured receiver at `https://mars.snazzie.space`; an unsigned empty-body route probe was rejected with HTTP 401 / invalid signature. No delivery for the disposable repository appeared in the latest 20 actual App deliveries. This is receiver reachability evidence, not signed PR-command UX proof.
- Fresh neutral-description author revision `d418a36d0a5ea9ce45a2ec0649e13e8e9e0ad17a` reached the matching socket-idle limit after about 597 seconds from the recorded provider call and failed with `llm_unavailable`. LM Studio recorded 2,217 reasoning tokens and empty final content; real GitHub reviews/inline comments remained empty. This is not an observed `llm_timeout` from the whole-request abort. Generation now disables Bun's redundant socket-idle timer and retains the 600-second whole-request abort as the sole bound.
- The updated real HTTP smoke rejected a delayed response under the child's default one-second idle timer, accepted the 35-second response with the socket-idle timer disabled (35,004 ms), and produced `llm_timeout` when the actual abort timer was accelerated from 600 seconds to one second. Provider suite: 20 passed, 0 failed; all workspace typechecks passed.
- The user selected **Use smaller local model**, explicitly accepting that the shared saved profile affects global CI and PR model selection. Actual AI settings UI editing and an authorized provider GET confirmed profile `84c009e2-8c43-4ee0-98f8-c7491581413d` now uses `google/gemma-4-e2b`. Base URL, credentials, opt-in/global enablement, prompts, token caps, and generation/interruption limits are unchanged. The original model was not unloaded and unrelated requests were not cancelled.
- A separate shared-model request was mapped to `Snazzie/MARS` / `Windows runner smoke` run `38015231153`, not the disposable fixture; it settled before new fixture work resumed. Its interrupted database state was not treated as proof the server had stopped decoding.
- Follow-up request: add an independent **Enable all PR reviews** control. Global PR settings default off, have their own provider/activation timestamp, override local selection for available approved repositories, and preserve local opt-ins for fallback. Generated `0013_aspiring_the_hood` adds only the global PR settings table; `db:check` and development/isolated migrations passed.
- Global-control proof: actual UI provider selection remained blocked from enabling until dedicated source consent; acknowledged activation persisted; a repository with local opt-in off displayed the effective global provider without changing its checkbox; native visual proof captured. The control was restored to off/provider unset afterward, and current CI global settings remained unchanged. The user requested the control, not permanent activation.
- Latest global-feature gate: 283 passed, 0 failed, 991 assertions across 11 focused suites; all workspace typechecks passed. PostgreSQL regressions cover global-only eligibility, provider precedence/fallback, activation boundary, generation-time disable/provider change, admin/provider validation, and preservation of CI/local settings. A Happy DOM selected-value getter disagreed with the correctly selected SSR option; that incidental renderer assertion was removed, with provider selection verified in actual Chromium rather than re-pinned.
- An intervening operator changed the shared saved model to `google/gemma-4-12b-qat` and current CI activation timestamp. The actual UI and authorized provider GET confirmed the current Google model; those changes were preserved, not overwritten by the earlier E2B choice.

## Goal

MARS automatically reviews opted-in repositories' pull requests and publishes advisory GitHub reviews with actionable inline findings. Reuse the existing AI provider configuration and GitHub App integration without changing CI failure analysis.

## Required boundaries

- Repository content is read-only. The review processor must never create or edit files, create commits or branches, push, apply fixes, merge, approve, or submit a request-changes verdict.
- GitHub writes are limited to publishing COMMENT reviews and their inline comments. MARS may persist settings, processing state, results, and usage in its own database.
- Suggested fixes are human-applied GitHub suggestion blocks only. MARS never applies or commits them. PR content, model output, and repository rules cannot authorize additional actions.
- Never execute PR code, repository scripts, or model-generated commands. Do not check out the PR into an execution environment.
- No merge-blocking check, autonomous coding agent, CI dependency, new provider type, or generic AI-job framework.

## User-visible behavior

### Settings

- Add a separate per-repository PR review toggle and provider selection to AI settings; disabled by default.
- A separately configured global **Enable all PR reviews** control may override those local opt-ins/provider choices for available approved repositories, including newly discovered repositories. It defaults off, is independent of CI Enable all, and preserves local settings for fallback when disabled.
- Only global administrators can change settings, matching existing AI configuration authorization.
- Enabling CI failure analysis does not enable PR review, and vice versa.
- Reuse saved provider profiles, encrypted credentials, model selection, token usage, and configured token prices.
- Explain before enabling that source code and PR metadata, including private-repository content and fork-origin changes, are sent to the selected provider.
- Enabling is prospective: no automatic backfill of existing PRs. The next eligible PR event triggers review.

### Triggers

- Handle `pull_request` actions `opened`, `synchronize`, `ready_for_review`, and `reopened`.
- Skip draft or closed PRs, disabled/unavailable repositories, unapproved installations, and unavailable providers.
- Process reviews independently of CI. Existing CI failure comments continue unchanged.
- Handle `closed` and `converted_to_draft` as invalidation events, without generating a review.
- Do not review description-only edits.

### Explicit review command

- Watch GitHub `issue_comment` events with action `created` on PR conversation comments. The approved command is `/review`, not `@mars review`. No Reviewers-sidebar identity or additional GitHub user/team is required.
- Match a standalone `/review` comment after trimming surrounding whitespace. Do not trigger from quoted text, fenced code, prose, extra arguments, normal issue comments, inline review comments, or edited/deleted comments.
- Accept commands only from non-bot users with current write, maintain, or admin access to the base repository. Verify repository permission through GitHub; do not rely solely on `author_association`. Ignore MARS's own output.
- Re-fetch authoritative PR state and review the current base/head revision, not revision data inferred from the comment payload.
- Commands respect repository opt-in, provider configuration, draft/closed checks, base-revision rules, and the no-commit/no-push boundary. They cannot enable review or override safety policy.
- If the same revision is pending/running or already published, reuse its status/result rather than generating a duplicate review. `/review` does not authorize a same-revision rerun.
- Record the trigger, comment ID, and requester for provenance. Deduplicate webhook deliveries and command comments before enqueueing.
- No polling watcher, additional acknowledgment comments, or comment edits are required: reuse signed webhook ingestion and the normal GitHub review publication path.

### Review output

- Collect and validate all findings before publication, then submit one native GitHub COMMENT review per captured PR revision with its summary and inline comments together in a single batch request. Do not post individual comments as findings arrive.
- Pin publication to the captured head commit. Include the reviewed revision, rules provenance, coverage limitations, and an AI-generated advisory disclaimer in the summary.
- Keep reviews concise: each finding is one bullet with severity, confidence percentage, location, concrete impact, and a brief suggested correction. Use the same format for inline findings and any summary-only findings; do not repeat full findings in both places.
- Severity is one of `Critical`, `High`, `Medium`, or `Low`, reflecting impact independently of confidence.
- Confidence is a model-estimated integer percentage from 0 to 100 representing confidence that the finding is a real issue supported by the supplied evidence, not a calibrated probability.
- Validate confidence and severity in structured output, then filter before rendering/publication: omit every finding below 60% from both summary and inline comments. Exactly 60% is included if other evidence/location checks pass. Missing or invalid confidence must not default to a publishable value.
- Example format: `- **High · 85% confidence** — ` followed by the file/line, a short failure scenario, and a short correction.
- For each safely expressible line correction, include a native fenced `suggestion` block in the inline comment plus a concise explanation of why the replacement fixes the concrete issue. The severity/confidence bullet precedes the suggestion.
- Structured suggestions contain the exact head-revision replacement range and replacement text. Validate the range against fetched source and GitHub's supported inline suggestion locations, including multi-line ranges. Reject overlapping/conflicting suggestions and malformed fences rather than publishing misleading replacements.
- Suggestions must preserve untouched surrounding code and use repository conventions. Do not invent an executable patch for a finding needing unavailable context, deleted-only lines, or a cross-file fix: explain the correction briefly without an applyable block when a safe local replacement cannot be provided.
- GitHub may let a human batch-apply the suggestions and create a commit. That action belongs to the human reviewer; MARS never invokes apply/commit APIs.
- Focus on correctness, security, regressions, and consequential performance problems. Avoid style-only findings and unsupported speculation.
- Validate findings against fetched patches. Invalid locations must never reach GitHub; retain a substantive finding in the summary only if its file and evidence can be validated, otherwise reject it.
- Bound output and deduplicate findings. Render safely without arbitrary mentions or model-controlled publication metadata.
- With no actionable findings, say “No actionable findings in the reviewed scope.” Do not imply approval or exhaustive safety.
- Older published reviews remain attached to their original commits. New revisions receive new reviews; no rewriting historical findings.

## Repository review rules

- Fetch `.mars/pr-rules.md` from the captured PR base commit through the installation token, not from the head commit or a mutable branch name.
- Include it as repository-specific review guidance alongside built-in review criteria.
- Rules may define project expectations and areas of attention, but cannot override read-only operation, safety controls, evidence requirements, or publication policy.
- Treat the file as untrusted guidance, not executable instructions. It cannot request secrets, tool execution, arbitrary network access, or write actions.
- When the PR changes this file, review the change under the existing base-version rules. The proposed rules do not govern their own review; they take effect for subsequent reviews after merging.
- Missing file is valid: use built-in criteria and record that no repository rules were present.
- Non-missing fetch errors, unsupported content, and oversized rules must produce a visible rules-loading failure, not a review claiming those rules were applied. Do not silently truncate rules.
- Record the rules path, base commit, blob SHA when present, and loading status with the review result.

## Context collection and limits

- Fetch authoritative PR state, changed-file metadata, and patches with installation authentication.
- Capture base/head SHAs and fetch supporting source from immutable revisions. Use GitHub's PR comparison semantics rather than a naive base-tip-to-head diff.
- Include PR title/description, bounded patches, relevant surrounding source, and repository rules. Never expose provider credentials or installation tokens to the model.
- Bound file count, source bytes, total context, output size, and provider execution time with explicit constants; reuse existing provider transport limits where appropriate.
- Exclude binary/generated content using conservative deterministic rules. Missing patches, deletions, renames, excluded files, and truncated coverage must be represented explicitly.
- Never label a partial review as complete. If no reviewable source remains, record a skipped result rather than a clean review.
- Use fixed GitHub API routes and repository-relative paths. Source text cannot supply arbitrary fetch destinations.

## Durable lifecycle and publication

1. Verify webhook signature and reuse existing delivery deduplication.
2. Resolve repository ownership, installation approval, settings, and provider; persist eligible work before completing delivery. Return promptly without a model call in the webhook.
3. Identify a revision by repository, PR number, base SHA, and head SHA. Enforce uniqueness in PostgreSQL in addition to webhook-delivery deduplication.
4. Coalesce rapid pushes: mark obsolete pending revisions superseded. Re-fetch authoritative PR state so out-of-order events cannot replace newer work with older payloads.
5. Claim pending work transactionally using the existing locked-claim pattern. Persist provider/model and pricing snapshots, source provenance, usage, timestamps, and safe error codes.
6. Recheck eligibility and captured revision before collecting context and before calling the provider.
7. Generate and validate a structured result. Recheck eligibility, base/head SHAs, settings, and provider before publication; skip stale work even if generation succeeded.
8. Track analysis and publication independently. Store generated results before publishing so publication recovery never requires another model call.
9. Include an app-owned marker identifying the PR revision in the review summary. Reconcile using marker, authoring app identity, and commit ID.
10. Treat timeouts/interruption during publication as an unknown outcome. Do not blindly repeat the POST; reconcile remote reviews first, and keep unresolved outcomes visible.
11. Recover interrupted processing using the existing lifecycle conventions without unbounded retries. Provider errors, rules-loading errors, permission errors, skipped work, and zero findings remain distinct.

A PR can change between the final eligibility check and GitHub publication. GitHub does not provide an atomic publish-if-head-unchanged operation. Pinning every review to its captured commit and labeling that revision prevents findings from being presented as a review of newer code.
## Remaining implementation decisions and verification gates

No architectural blocker is currently identified. The following details are unresolved or unverified; implementation must close them rather than treating planned behavior as proven.

| Area | Open detail or risk | Required resolution |
| --- | --- | --- |
| Installed GitHub App | Existing installations may lack event subscriptions or required permissions. | Check PR/source reads, requester permission lookup, PR conversation comment delivery, and review publication. Document setup changes without adding unrelated write permissions. |
| Native suggestions | Exact GitHub range behavior for multi-line suggestions, renames, and deleted lines has not been exercised. | Verify supported ranges against actual GitHub reviews. Fall back to concise explanation-only findings when a safe replacement cannot be expressed. |
| Context budget | Exact file count, source/context byte limits, rules-file cap, and generated-file exclusions are not selected. | Choose conservative explicit constants using existing provider limits, document them, and test boundaries. Report partial coverage; never silently truncate repository rules. |
| Provider output | Structured output reliability and useful confidence estimates vary by provider/model. | Validate schema and evidence, enforce the 60% threshold in server code, and exercise the selected provider on known issues. Do not present model confidence as a calibrated probability. |
| Publication recovery | GitHub may accept a batch review before a lost response leaves its outcome unknown. | Exercise lost-response recovery and app-owned marker reconciliation. Do not retry the POST blindly or call the model again to recover publication. |

### Confirmed decisions

- `/review` is a request to review the current revision, not a force-rerun command. Existing pending/running or published work is reused; no additional review or model spend for that same revision.
- The final-check/publication race cannot be eliminated with the planned GitHub API. Review commit pinning and explicit revision labeling are mandatory; never claim coverage of newer code.
- Concise explanation-only findings are permitted when a valid local suggestion is impossible. This is not permission to invent a patch or apply a fix.
- Platform permissions, provider quality, and native suggestion behavior are verification gates, not assumptions supporting a completion claim.

### Required end-to-end proof

In the disposable installed repository, observe the full `/review` path: authorized PR conversation comment → signed webhook → current revision capture → base-version `.mars/pr-rules.md` → selected provider → validated findings at or above 60% → one GitHub batch COMMENT review with valid native suggestions. Confirm the branch and commit history are unchanged by MARS. Separately prove repeated commands reuse the same-revision result without another model call or duplicate review.


## Implementation sequence

### 1. Contracts, schema, and repository settings

- [x] Add PR review settings and validated review/result/status contracts in `packages/contracts/src/dashboard.ts`.
- [x] Add independent repository settings and durable review/publication records in `packages/db/src/drizzle-schema.ts` with organization/repository ownership constraints and revision uniqueness.
- [x] Preserve CI analysis tables and semantics. Do not copy pipeline-specific fields into the PR-review lifecycle.
- [x] Generate migrations with `bun run db:generate` from `packages/db`; run `bun run db:check`, then `bun run db:migrate` in the verification environment. Never hand-author numbered migration SQL.

### 2. GitHub event ingestion and read-only client boundary

- [ ] Add `pull_request` and `issue_comment` to the manifest subscriptions in `apps/control-plane/src/github-app.ts`; existing manifests already request pull-request write permission. Verify the installed App can receive PR conversation comments without requesting unrelated issue-write access.
- [x] Document updating existing GitHub Apps' webhook subscriptions and checking installed permissions. Do not claim changing the generated manifest updates existing apps.
- [x] Extend `apps/control-plane/src/http/github-routes.ts` with typed PR event handling using existing signature/delivery controls.
- [x] Handle new PR conversation `/review` comments: strict command parsing, bot exclusion, authoritative requester-permission checks, comment/delivery deduplication, and enqueueing through the same revision-aware processing path.
- [x] Introduce a focused PR-review GitHub client exposing only PR/source/review reads and COMMENT review publication. Do not expose repository mutation helpers to the review processor.

### 3. Context and provider generation

- [x] Implement immutable source collection, patch/location mapping, coverage accounting, and base-revision `.mars/pr-rules.md` loading.
- [x] Reuse `apps/control-plane/src/llm-providers.ts` transport, credentials, timeouts, LM Studio handling, sanitization, and usage capture; add a separate review prompt and result validator.
- [x] Add validated severity and integer `confidencePercent` fields to the review result schema. Enforce the 60% publication threshold in server code, not only in the prompt or repository rules.
- [x] Add structured replacement ranges/text and concise rationale to review findings; validate source alignment, supported suggestion ranges, conflicting replacements, and safe Markdown fence rendering before publication.
- [x] Keep CI analysis and PR review prompts/results separate. Share genuine transport primitives only, and check references before changing exported interfaces.

### 4. Processing and publication

- [x] Add `apps/control-plane/src/pr-review.ts` to own enqueueing, transactional claims, eligibility checks, generation, safe rendering, and publication reconciliation.
- [x] Register its processor in `apps/control-plane/src/index.ts` using the existing background scheduling pattern.
- [x] Persist superseded/failed/skipped/completed analysis states separately from pending/publishing/published/failed/unknown publication states.
- [x] Make permission and rules-loading failures actionable without leaking credentials or raw provider errors.
- [x] Publish the summary and all accepted inline findings/suggestion blocks through one create-review request with `event: COMMENT` and the captured `commit_id`. Preserve whole-review outcome reconciliation; never fall back to per-finding POSTs.

### 5. API and AI settings surface

- [x] Extend `apps/control-plane/src/http/dashboard-routes.ts` with organization-scoped, admin-authorized PR review settings endpoints and read-only review status access.
- [x] Extend `apps/web/src/api.ts` and `apps/web/src/routes/AiSettingsPage.tsx` with separate repository opt-in/provider controls and source-sharing disclosure.
- [x] Surface latest review state, reviewed revision, usage/cost when known, rules/coverage status, errors, and published review URL in the repository AI settings surface. Do not tie PR status to a CI run.

## Acceptance and verification

Permanent regression coverage must test consumer-visible behavior, not copied source text or mocked forwarding:

- [x] An enabled non-draft PR produces an advisory review with valid commit-specific inline findings; disabled, draft, closed, unavailable, and unapproved cases do not call the provider or publish.
- [ ] Repository rules affect review criteria; missing rules use defaults; inaccessible/oversized rules fail visibly.
- [x] A head-version rules change cannot replace base-version guidance. Rules and PR text cannot authorize writes or tool execution.
- [x] Duplicate deliveries, duplicate revision events, out-of-order pushes, and concurrent claims do not duplicate processing or publication.
- [x] An authorized user's standalone `/review` PR conversation comment triggers review of the current revision. Prose/quotes/code, extra arguments, issue-only comments, inline comments, edits, bot comments, and unauthorized users do not trigger generation. Existing pending/completed revision work is reused without duplicate publication.
- [x] A push, draft conversion, close, disable, or provider change during generation prevents publication of the stale result.
- [x] Invalid paths/lines, malformed model output, renames/deletions, missing patches, and context limits are handled without fabricated findings or exhaustive coverage claims.
- [x] Concise finding bullets include severity and confidence percentage. A 59% finding is absent from all published output; a valid 60% finding survives filtering. Missing, fractional, out-of-range, or otherwise invalid scores cannot produce a publishable finding. If all findings are filtered out, publish the normal no-actionable-findings statement without listing rejected candidates.
- [x] Multiple actionable findings appear in one GitHub review batch, with severity/confidence, concise reasons, and native line-change suggestions where safe. Single-line and multi-line suggestions replace precisely the intended head-revision text; invalid/conflicting suggestions are not published. Filtering below 60% also removes their suggestion blocks.
- [x] A lost GitHub publication response is reconciled without a duplicate POST. Provider and permission errors never appear as clean reviews.
- [x] Organization guards prevent cross-organization settings and result access.
- [x] Existing CI failure analysis behavior remains unchanged after shared provider changes.

Run focused Bun suites for affected provider, webhook, processor, DB, API, and UI behavior after implementation. Test commands and results must be recorded only when actually exercised; PostgreSQL-dependent checks require a migrated test database.

Checked regression items above refer to the migrated local suite, not to signed
live webhook delivery or real GitHub rendering. The runtime checklist below is
separate and remains incomplete while the installed App subscriptions are missing.

Then exercise the real surface, not just mocks:

- [ ] In a disposable installed repository, enable review through the AI settings UI and open a PR with a known actionable bug and a base-branch rules file.
- [ ] Observe the actual GitHub COMMENT review, inline location, reviewed SHA, rules provenance, coverage, and persisted status/usage.
- [ ] Push a second revision while generation is running; confirm obsolete work is skipped and the current revision is reviewed.
- [ ] Exercise a rules-file edit and confirm base rules remain authoritative.
- [ ] Post `/review` in the actual PR conversation as an authorized user and observe the resulting review or reuse of the existing revision result. Verify an unauthorized commenter cannot invoke generation. Do not substitute a synthetic webhook for proof of this UX.
- [ ] Repeat `/review` for the same published revision and confirm no new model call or duplicate review. Observe real GitHub multi-line suggestion rendering and verify explanation-only handling where a safe suggestion is unsupported.
- [x] Compare branch refs and commit history before/after review to prove MARS created no commits or branches, pushed nothing, and merged nothing. Author-driven smoke pushes are separate from review activity.
- [ ] Verify the AI settings UI in a browser and confirm existing CI comments still work.

After successful smoke proof, update existing user documentation/changelog with opt-in, source sharing, `.mars/pr-rules.md`, existing-app subscription setup, advisory semantics, limits, and the no-commit/no-push guarantee. Remove temporary smoke scaffolding.

## Completion condition

All acceptance checks pass, actual UI and GitHub publication are observed, affected CI analysis behavior remains intact, and documentation reflects the delivered behavior. Planning alone does not constitute implementation or runtime verification.
