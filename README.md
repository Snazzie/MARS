# MARS

<img src="assets/mars-logo.png" alt="MARS logo" width="320">

**MARS (Managed Action Runner System)** brings scattered Windows, macOS, and Linux hardware together as your own GitHub Actions runner cluster. Manage workers centrally while choosing the platform and compute resources each workflow needs.

## Features

- **Pool the hardware you already have:** Bring workers on different hosts into a centrally managed runner fleet.
- **Install with one copied command:** Choose a supported platform in the dashboard, copy its generated install command, and run it on your hardware. Under **All workspaces → Workers**, expand the pending worker's **Review and approve** panel, verify its fingerprint and public key, choose an available runtime on Windows, set worker capacity and per-job limits, and approve it before it accepts jobs. Action cache settings are optional and collapsed by default.
- **Join with Node.js:** The dashboard also shows `npx --yes @snazzie/mars-worker-cli@0.1.0 --control-plane-url <origin> --join-code <one-use-code>` for the default runtime on supported hosts (Windows x64/ARM64, Ubuntu 24.04 x64, macOS ARM64). Requires Node.js 20+, a configured worker connection origin, and available platform release artifacts. Custom Windows VM provisioning uses the platform-specific dashboard command. The npx package must be published to npm before this command works outside the repository.
- **Run multiple jobs per worker:** Allocate a worker's capacity across concurrent jobs instead of dedicating a whole machine to each job.
- **Share workers across organizations:** Use one worker fleet for repositories in multiple GitHub organizations.
- **Request the compute you need:** Specify CPU and memory in resource-aware `runs-on` labels, and route jobs to compatible pools. [Routing guide](docs/worker-routing-labels.md).
- **Retry failed workflow jobs:** Add a bounded `mars-retry-N` label to request GitHub reruns after failures, without changing the chosen worker resources.
- **Keep downloads local:** A worker-local caching proxy reduces repeated downloads of GitHub Actions resources.
- **Choose the execution environment:** Route across Windows x64, macOS ARM64, and Linux x64 pools; Windows supports Hyper-V-isolated containers or checkpoint-based VMs, and macOS uses Tart images. [Windows runtime options](docs/windows-worker-runtimes.md).
- **Manage the fleet from one place:** Onboard and approve workers, inspect health, and connect repositories through the control plane and dashboard.
- **Recover worker configuration automatically:** Fresh idle health reports retry failed configuration when the selected runtime is ready and the prior configuration command is at least 30 seconds old. Windows workers acknowledge revisions already applied in the current process without disturbing running jobs; changed configurations wait for active leases to finish and block new lease pickup until applied. Recovery still requires a matching worker acknowledgement before dispatch resumes.
- **Diagnose dispatch from Overview:** The compact Dispatcher service card keeps **Current load** (allocated slots, configured ceiling, and utilization), current activity, live queue/capacity metrics, and **Current pool checks** visible. Pool checks use compact wrapping cards instead of full-width rows. Load and awaiting-dispatch counts remain visible even when dispatcher telemetry is unavailable. Expand **Scheduling & previous passes** for the next timer tick or queued rerun, the last completed pass, and historical blocker counts. Expand **Previous pass blocked jobs** within it for routing labels and GitHub job links. Queue exclusions and health warnings remain visible without expanding diagnostics. The card supports light and Martian themes, narrow screens, and keyboard-operated disclosures. The default dispatch timer runs every five seconds; a pass cannot start while GitHub lease checks, discovery, or cleanup from the prior cycle are still running.
- **Configure AI failure analysis:** Global administrators use **Settings → AI** (`/settings/ai`); Settings has its own General/AI navigation and a Back to dashboard link. Provider choices include **LM Studio**, **Ollama**, **OpenAI-compatible**, and **Anthropic**. Blank API roots use the selected entry's default: `http://localhost:1234/v1`, `http://localhost:11434/v1`, `https://api.openai.com/v1`, or `https://api.anthropic.com/v1`, respectively. LM Studio discovers downloaded text-generation models through `/api/v1/models`; other OpenAI-compatible providers use `/v1/models`. The available-model dropdown is the only model control when discovery returns models. Manual entry is shown when discovery fails, returns no models, or the provider is Anthropic. Start LM Studio's Developer server or Ollama's API server before connecting. Save the profile and click **Test model** to generate and validate a synthetic analysis without sending repository logs. LM Studio profiles check loaded instances before each analysis, reuse an existing instance, or load the selected downloaded model through `/api/v1/models/load`; JIT loading is not required. Loading has a three-minute timeout, separate from the 90-second inference timeout. MARS does not download models, unload other models, or override loading settings. Requires LM Studio's native `/api/v1` model-management API; reverse-proxy API roots must end in `/v1`, and their path prefixes are preserved. `localhost` refers to the control-plane host, not a remote worker; for remote local models, configure a reachable address and restrict network access appropriately. Keys are never prefilled, and changing provider type clears the retained key unless explicitly restored. Repository access is a table with one shared provider/model selector, individual enable switches, and a persisted **Enable all** override. The override short circuits individual selections without changing their checkboxes and includes newly discovered repositories; turning it off restores individual enablement. Unavailable repositories remain excluded. Changing the shared provider applies it to every listed repository while preserving enable states. Enabling requires acknowledgement that failed log excerpts go to the selected endpoint and generated feedback is posted on associated PRs by the installed MARS App. Failed bulk updates are reported and refreshed; retry to finish applying the shared configuration.
- **Queue AI feedback off the job path:** Failed-job ingestion durably queues one AI analysis event per run attempt, in the same transaction as the job update. The background worker waits for a complete run snapshot and analyzes all failed jobs together. When dequeued, an event superseded by a newer run of the same workflow and branch, or a newer attempt, is skipped without a model call. GitHub is checked even if the newer run has not been discovered locally; freshness is checked again after generation and before posting a comment.
- **Inspect AI run results and comments:** Open **Runs → Recent runs** in the AI run section to inspect completed, failed, and skipped analyses per run attempt. Expand **Analysis result** for explanations, evidence, and suggested fixes; expand **Posted comment** for the exact saved GitHub comment text. Run details also show comment text. Publication status and errors are separate from analysis status; failed or uncertain posts are labeled **Submitted comment body**, not posted. Older comments without saved text show **Comment body unavailable** and retain their GitHub link; text is not regenerated. Apply database migrations before deploying this version. The additive nullable `comment_body` column preserves existing rows and can remain when rolling application code back.
- **Track AI usage and performance:** Overview and AI Settings show global administrators two compact half-width widgets, stacking on narrow screens. **AI usage** has **Cost / Tokens** tabs that switch the total and daily aggregate chart over the trailing 30 UTC days; no models table is shown. **AI run performance** shows nearest-rank p50/p95 time to start (enqueue to worker claim) and time to complete (worker claim to finish, excluding publishing), with separate sample counts. It covers failure analyses and PR reviews enqueued in the same 30-day UTC window, including failed runs with recorded timings. Missing or reversed timestamp pairs are excluded; no samples shows a dash, not zero. Both widgets are deployment-wide, independent of the Overview workspace and reporting-period controls. Token counts come from OpenAI-compatible `prompt_tokens`/`completion_tokens` or Anthropic `input_tokens`/`output_tokens`; Anthropic cached-read and cache-creation tokens are included in input totals. Missing telemetry is reported separately, never estimated as zero. Historical calls without recorded usage are not reconstructed. Pipeline calls retain usage even if generated analysis is invalid or later superseded. LM Studio API cost is always **$0**, including historical calls with missing or nonzero prices; locally configured Ollama profiles also use zero rates. For cloud profiles, configure input/output USD prices per million tokens; prices are snapshotted when an analysis is queued, so later price edits do not rewrite historical estimates. Cost is an estimate, not a provider invoice: cache discounts, tiered pricing, taxes, hardware, and electricity are excluded. Missing pricing or chargeable usage makes total cost unavailable and hides the cost chart rather than silently understating it. Connection-test requests are not included. No database migration is needed; deploy the matching control plane and dashboard together.

Provider list, create, and update responses expose only the public profile fields and
`keyConfigured`; database timestamps and encrypted keys remain on the control plane.
Unconfigured token prices are returned as `null`.
Successful provider deletion returns HTTP 200 with `{ "ok": true }`, matching the
dashboard mutation contract.
The blanket override migration is additive and defaults off, preserving existing
repository settings. Apply pending migrations before deploying the updated control
plane (`bun run db:migrate` from `packages/db`). Rolling back application code uses
the unchanged individual settings; leave the new table in place.

The LM Studio migration expands the provider-kind constraint without changing
existing profiles, keys, models, or repository selections. After applying it,
edit existing generic profiles that use LM Studio and select **LM Studio** to
enable explicit loading; preserve their model, API root, and retained key when
saving. Deploy the matching control plane and dashboard together. Before rolling
back to an older application, change LM Studio profiles to **OpenAI-compatible**
(keeping their model, root, and key) and enable LM Studio JIT or manually load
the model. Leave the expanded database constraint in place.

> **Development status:** MARS is not yet a production-ready runner platform. Control-plane hosting is the current Linux/amd64 deployment milestone; end-to-end GitHub Actions job execution remains unfinished. See [implementation status](IMPLEMENTATION-STATUS.md) for the precise scope and blockers.

## Retry failed jobs

Add `mars-retry-3` alongside a resource-aware routing label to allow up to three additional executions after a failed or timed-out job:

```yaml
runs-on: [mars-any-2vcpu-4g, mars-retry-3]
```

`N` must be a whole number from 1 to 10 without a leading zero. Mars requests at most one rerun per completed workflow run attempt; a successful or cancelled job is not retried. GitHub reruns the selected job **and its dependent jobs**, so the retry budget is shared by the run attempt. Failed API requests are not automatically repeated: an ambiguous response could already have started another execution.

Existing GitHub App installations need **Actions: write** permission approved and the installation reauthorized before automatic reruns work. Updating the app manifest alone does not grant this permission.

## Cost estimates

Overview savings and Cost Center estimates use the actual job interval from
`started_at` to `completed_at`, excluding queue time, provisioning, and waiting
for a ready runner to pick up the job. Jobs without a recorded start are excluded.
Each started job is rounded up to whole billable minutes, with a one-minute minimum.
The same runtime basis applies to GitHub, Blacksmith, and Azure VM comparisons.
Existing history is recalculated from its recorded timestamps; no data migration
is required.

## Get started

Each control plane is a **private, administrator-managed installation**, not a public sign-up service. It can connect multiple GitHub organizations and personal accounts. Members of any actively installed organization can sign in with GitHub; a personal installation admits its account owner. Signing in does not create another workspace or grant administration.

Open `/onboarding` to configure the public HTTPS URL, create the GitHub App, sign in as the administrator, install the App with access to at least one repository, and enroll and configure a worker. Setup progress is saved; repository access can be corrected in GitHub and verified without restarting setup.

After the first operator claims administration, unrelated GitHub accounts are rejected before creating a local user or session. Authorized members receive access only to their installed organizations; setup and installation management remain administrator-only. Existing installations and their data stay together—no tenant split or database migration is required.

Returning sign-ins refresh workspace memberships, retaining authorized installations and removing stale access before issuing a session.

- [Development setup and worker commands](docs/development.md)
- [Windows worker runtimes and prerequisites](docs/windows-worker-runtimes.md)
- [GPU runner evaluation and deferred design](docs/gpu-runner-evaluation.md)
- [Control-plane deployment guide](deploy/control-plane/README.md)
- [Implementation status](IMPLEMENTATION-STATUS.md)

## License

No license has been declared yet.
