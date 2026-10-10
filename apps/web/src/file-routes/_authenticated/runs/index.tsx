import { createFileRoute } from "@tanstack/react-router";
import { RunsPage } from "../../../routes/RunsPage.tsx";

export const Route = createFileRoute("/_authenticated/runs/")({
  component: RunsPage,
  staticData: { navigation: { label: "Jobs", order: 2, section: "primary" } },
});
