import type { DashboardPeriod } from "@mars/contracts";

export const reportingPeriodLabels: Record<DashboardPeriod, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
const reportingPeriods: readonly DashboardPeriod[] = ["24h", "7d", "30d"];

export function ReportingPeriodControl({ value, onChange, label }: { value: DashboardPeriod; onChange: (period: DashboardPeriod) => void; label: string }) {
  return <fieldset className="overview-period-control" aria-label={label}><legend className="sr-only">{label}</legend>{reportingPeriods.map((period) => <label key={period} className={value === period ? "is-selected" : ""}><input type="radio" name={`${label}-period`} value={period} checked={value === period} onChange={() => onChange(period)} /><span>{period}</span></label>)}</fieldset>;
}
