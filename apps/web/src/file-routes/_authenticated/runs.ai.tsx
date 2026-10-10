import { createFileRoute } from "@tanstack/react-router";
import { AiRunsPage } from "../../routes/AiRunsPage.tsx";

export const Route = createFileRoute("/_authenticated/runs/ai")({
  component: AiRunsPage,
  staticData: { navigation: { label: "AI", order: 1, section: "primary", help: { label: "About AI runs", text: "What: AI failure analyses for the selected workspace. How: switch between Recent runs and Queue, inspect analysis results and posted comments, or open the associated job run. Fix: check AI Settings for provider configuration or inspect the reported analysis and publishing errors." } } },
});
