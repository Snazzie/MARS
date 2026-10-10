import { Outlet, createFileRoute } from "@tanstack/react-router";

function WorkersLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/_authenticated/workers")({
  component: WorkersLayout,
  staticData: { navigation: { label: "Workers", order: 4, section: "primary", help: { label: "About worker readiness", text: "What: enrollment, connection, configuration, doctor checks, and free capacity. How: adopt a pending host, configure its supported runtime, then wait for the applied revision. Fix: follow the reported remediation and drain before removal." } } },
});
