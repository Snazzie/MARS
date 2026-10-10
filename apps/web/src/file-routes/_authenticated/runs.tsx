import { Outlet, createFileRoute } from "@tanstack/react-router";

function RunsLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/_authenticated/runs")({
  component: RunsLayout,
  staticData: { navigation: { label: "Runs", order: 2, section: "primary", help: { label: "About run history", text: "What: GitHub workflow jobs observed by Mars. How: filter by repository, branch, actor, status, or conclusion and open a run for jobs, stages, and logs. Fix: use the linked GitHub run when cancellation or rerun is required." } } },
});
