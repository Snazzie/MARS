import { Outlet, createFileRoute } from "@tanstack/react-router";

function RunsLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/_authenticated/runs")({ component: RunsLayout });
