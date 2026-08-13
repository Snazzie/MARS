---
target: current Whitesmith web UI layout/design
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-08-13T14-19-22Z
slug: apps-web-src-routes-overviewpage-tsx
---
⚠️ DEGRADED: single-context (the design-review subagent did not return the requested assessment; parent completed source and browser synthesis after an independent detector pass)

# Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|---:|---|
| 1 | Visibility of System Status | 2 | Loading/error states exist, but the shell exposes “Control plane connected” while page data is 404 in the static shell; no clear last-updated/connection distinction. |
| 2 | Match System / Real World | 3 | “Runs”, “Repositories”, “Workers”, and “Pools” are understandable; terms like “runner pools”, “pod”, and “safety envelope” need contextual explanation. |
| 3 | User Control and Freedom | 2 | Navigation is available, but destructive uninstall relies on a browser confirm and multi-step flows have weak cancellation/rollback cues. |
| 4 | Consistency and Standards | 3 | Reusable page headers, panels, buttons, and query states are consistent; action density and control placement vary sharply between pages. |
| 5 | Error Prevention | 2 | Some validation exists, but resource fields use raw bytes and destructive GitHub actions are easy to trigger from a dense action cluster. |
| 6 | Recognition Rather Than Recall | 2 | Active nav and labels help; users must remember what a pool’s labels, image digest, and raw resource units mean. |
| 7 | Flexibility and Efficiency | 1 | No visible keyboard shortcuts, bulk actions, saved filters, or compact power-user path in the data-heavy areas. |
| 8 | Aesthetic and Minimalist Design | 2 | Strong visual identity, but the Repositories surface presents refresh, sync, connect, uninstall, search, availability, and visibility controls together. |
| 9 | Help Users Recognize, Diagnose, Recover | 2 | QueryState gives a retry, but errors are not consistently mapped to user action and do not preserve/restore context visibly. |
| 10 | Help and Documentation | 1 | No contextual help, glossary, or task-oriented guidance is visible for onboarding, pool capacity, labels, or GitHub permissions. |
| **Total** | | **20/40** | **Acceptable at best; significant UX reduction and guidance work needed.** |

## Design Specificity Verdict

**LLM assessment:** The interface is authored rather than generic: dark operator-console palette, editorial serif headings, numbered rail, acid/rust status accents, and operational copy (“The fleet, at a glance”, “Know where work lands”). The tradeoff is that the visual language is more distinctive than the information architecture. Most pages still follow the same “large headline + explanatory sentence + dense controls/panels” pattern, so the product character does not yet reduce decision complexity.

**Deterministic scan:** 2 warnings, both `side-tab` findings in `apps/web/src/styles.css`: line 9 (`border-left:3px solid var(--rust)`) and line 14 (`border-left:3px solid var(--acid)`). These are P3 decorative-pattern concerns, not functional blockers. No other detector rules fired. Built artifact scan returned 0 findings, but the file:// browser pass was invalid because JS/CSS assets were blocked by file-origin/CORS; no route-level detector evidence is claimed.

**Browser evidence:** A proper local static server on port 4183 rendered the shell. At 1440px, the rail is clear and balanced, but the content area becomes a large empty field when data fails; the error card is visually isolated from the “connected” rail status. At 390px, the six-link rail becomes a clipped horizontal nav (“P…”) rather than a deliberate mobile navigation pattern. The loading card is readable, but the page provides no mobile-level navigation affordance or visible way to reach clipped items.

## Overall Impression

The shell looks deliberate and credible, but the product asks operators to parse too many peer-level controls and technical units before they can act. The biggest opportunity is not more styling; it is progressive disclosure and explicit information hierarchy.

## What's Working

- Strong authored identity: dark green-black surface, acid status color, editorial typography, and numbered navigation distinguish Whitesmith from a generic admin template.
- Shared shell primitives are consistent: `AppShell.tsx:25-50`, `page-header`, `QueryState`, and panel treatments create a recognizable system.
- The overview concept is directionally right: current load, queue, completed/failed counts, and a period control put operational signal first (`OverviewPage.tsx:21-30`).

## Priority Issues

### [P1] Mobile navigation is clipped, not responsive
**Where:** `AppShell.tsx:36-42`; `styles.css:5,19-21`; browser viewport 390px.

**Why it matters:** Repositories, Workers, Pools, and Settings are partly or fully inaccessible by sight/touch. This is a task-completion issue for mobile and a discoverability failure for keyboard users navigating a horizontally clipped region.

**Fix:** Replace the rail with a compact mobile header plus labeled menu/drawer or bottom navigation. Preserve active state and workspace selector. If horizontal navigation remains, make it intentionally scrollable with visible affordance and no clipped labels.

**Suggested command:** `/impeccable adapt`

### [P1] Repositories is an action wall
**Where:** `RepositoriesPage.tsx:86-135` and `145-176`.

**Why it matters:** Refresh connection, sync repositories, connect workspace, uninstall, availability, search, and visibility are all surfaced before the repository list. Users cannot tell which action is primary, which is rare/admin-only, or whether they are reading or mutating data.

**Fix:** Make “Connect workspace” the single primary action. Move refresh/sync/uninstall into a “GitHub connection” disclosure or overflow menu. Put search and filters in a compact filter row with a “More filters” disclosure. Keep destructive uninstall separated and visually dangerous.

**Suggested command:** `/impeccable distill`

### [P1] Technical values are exposed without translation
**Where:** `SettingsPage.tsx:7-8,19`; `PoolsPage.tsx:25,32`.

**Why it matters:** “Memory per pod (bytes)” and “Storage per pod (bytes)” force operators to calculate units and invite ten- or thousand-fold mistakes. Pool setup also exposes labels/image digest/concurrency concepts without inline explanation.

**Fix:** Use GiB/GB fields with explicit units and sane defaults; show the canonical byte value only as secondary detail. Add short inline help for trigger labels, platform labels, immutable image digest, concurrency, and the relationship between organization limits and pool limits.

**Suggested command:** `/impeccable clarify`

### [P1] Status messaging conflates shell health with page data health
**Where:** `AppShell.tsx:44`; `StateView.tsx` usage in pages; browser evidence.

**Why it matters:** “Control plane connected” remains visible while page content can be a 404 error. Operators may infer the fleet is healthy when only the static shell loaded, or may not know whether to retry the page, reconnect GitHub, or inspect the backend.

**Fix:** Split status into “UI connected”, “API reachable”, and “GitHub connection” states. Put the failed request’s scope and next action inside the content region. Show last successful update timestamp on operational pages.

**Suggested command:** `/impeccable harden`

### [P2] Onboarding and configuration complexity is not progressively disclosed
**Where:** `OnboardingPage.tsx`; `WorkersPage.tsx:16`; `PoolsPage.tsx:27-33`.

**Why it matters:** First-timers see infrastructure concepts before they understand the end-to-end goal. Power users get a long, interruptible sequence with little visible progress/context at the point of configuration.

**Fix:** Keep the durable wizard, but make each step answer one question: connect GitHub, select worker, set capacity, create pool, verify first run. Put advanced limits, raw identifiers, and digests behind “Advanced”. Add persistent progress and a summary of what is already complete.

**Suggested command:** `/impeccable onboard`

## Cognitive Load

**Failed checklist items: 5/8 (high):**
- Single focus: Repositories mixes connection management, destructive actions, and list filtering.
- Chunking: several action groups exceed four visible decisions.
- Visual hierarchy: primary vs secondary/destructive actions are not sufficiently separated.
- Minimal choices: the repository header/toolbar exposes more than four simultaneous decisions.
- Progressive disclosure: raw infrastructure settings and GitHub controls are immediately visible.

Grouping and working-memory context are otherwise reasonable on the shell and overview.

## Persona Red Flags

**Jordan (first-timer):** “Connect workspace” competes with refresh/sync/uninstall; no contextual explanation of what connecting changes. Pool labels, image digests, and “pod” terminology require prior knowledge. No visible help path.

**Alex (power user):** No keyboard shortcuts, bulk repository approval, saved filters, or compact batch operations. Repositories forces several controls before list work; worker/pool management appears one object at a time.

**Sam (accessibility-dependent):** Mobile clipping removes access to nav items. Status is partly visual/color-coded (`online-dot`, acid/rust accents). Error recovery is generic retry rather than scoped, announced guidance. Focus styling exists in places but should be audited across custom panels, menus, and disclosure states.

## Minor Observations

- Repeated marketing-like headlines consume vertical space in an operator console; use tighter task labels on dense pages while preserving the visual voice.
- “All workspaces” is a global scope with high blast radius; the selector should display an explicit scope summary and confirm when actions are disabled because scope is global.
- The rail’s “Runner operations / 01” appears static and does not communicate current section; active link already carries that job.
- Detector flags the repeated colored left-border treatment as a P3 side-tab pattern (`styles.css:9,14`). Keep one intentional accent rule or replace with a more semantic status treatment.
- The shell error state can leave most of the viewport empty; add next-step context and recent successful timestamp rather than only Retry.

## Questions to Consider

- What is the one job an operator must complete from each page, and what can move behind “More”?
- Can a first-time operator create a working pool without knowing bytes, labels, digests, or pod terminology?
- Should “Repositories” be a read surface with a separate “GitHub connection” settings surface?
- What does the mobile experience need to support: monitoring only, or full mutation/control?
- Which status is authoritative when UI, API, GitHub, and worker connectivity disagree?
