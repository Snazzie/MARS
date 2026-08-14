import type { OverviewDto } from "@whitesmith/contracts";

type JobOutcome = NonNullable<OverviewDto["jobOutcomes"]>[number];
type Platform = keyof JobOutcome["platforms"];

const outcomes = ["queued", "running", "completed", "failed"] as const;
const platforms: readonly { key: Platform; label: string }[] = [
  { key: "macos", label: "macOS" },
  { key: "ubuntu", label: "Ubuntu" },
  { key: "windows", label: "Windows" },
  { key: "other", label: "Other" },
];
const platformClass: Record<Platform, string> = { macos: "outcome-platform-macos", ubuntu: "outcome-platform-ubuntu", windows: "outcome-platform-windows", other: "outcome-platform-other" };
const outcomeLabels: Record<(typeof outcomes)[number], string> = { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed" };

export function OutcomeBars({ outcomes: values, label = "Job outcomes" }: { outcomes: readonly JobOutcome[]; label?: string }) {
  const byOutcome = new Map(values.map((value) => [value.outcome, value]));
  const total = values.reduce((sum, value) => sum + Object.values(value.platforms).reduce((platformTotal, count) => platformTotal + count, 0), 0);
  if (!total) return <p className="chart-empty">No outcomes recorded yet.</p>;
  const summary = outcomes.flatMap((outcome) => platforms.map(({ key, label: platformLabel }) => `${outcomeLabels[outcome]} ${platformLabel}: ${byOutcome.get(outcome)?.platforms[key] ?? 0}`)).join(", ");
  return <div className="outcome-chart" role="img" aria-label={`${label}. ${summary}`}>
    <div className="outcome-bars" aria-hidden="true">
      {outcomes.map((outcome) => {
        const value = byOutcome.get(outcome);
        const outcomeTotal = platforms.reduce((sum, { key }) => sum + (value?.platforms[key] ?? 0), 0);
        return <div className="outcome-bar-column" key={outcome}>
          <div className="outcome-bar" title={`${outcomeLabels[outcome]}: ${outcomeTotal}`}>
            {platforms.map(({ key, label: platformLabel }) => { const count = value?.platforms[key] ?? 0; return count ? <span className={`outcome-bar-segment ${platformClass[key]}`} key={key} style={{ flexGrow: count }} title={`${platformLabel}: ${count}`} /> : null; })}
          </div>
          <span className="outcome-bar-value">{outcomeTotal}</span>
          <span className="outcome-bar-label">{outcomeLabels[outcome]}</span>
        </div>;
      })}
    </div>
    <div className="outcome-legend">{platforms.map(({ key, label: platformLabel }) => <span key={key}><i className={`outcome-legend-swatch ${platformClass[key]}`} />{platformLabel}</span>)}</div>
  </div>;
}
