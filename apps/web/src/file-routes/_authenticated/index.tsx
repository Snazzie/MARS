import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "../../routes/OverviewPage.tsx";

export const Route = createFileRoute("/_authenticated/")({
  component: OverviewPage,
  staticData: { navigation: { label: "Overview", order: 1, section: "primary", help: { label: "About overview health", text: "What: workload outcomes and control-plane freshness for the selected workspace. How: change the time window to inspect trends. Fix: open Workers when capacity or runtime health is degraded, then Runs for individual failures." } } },
});
