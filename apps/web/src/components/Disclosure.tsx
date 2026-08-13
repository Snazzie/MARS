import type { ReactNode } from "react";

export function Disclosure({ label, children, defaultOpen = false, tone = "default" }: { label: string; children: ReactNode; defaultOpen?: boolean; tone?: "default" | "danger" }) {
  return <details className={`disclosure disclosure-${tone}`} open={defaultOpen || undefined}><summary>{label}</summary><div className="disclosure-content">{children}</div></details>;
}
