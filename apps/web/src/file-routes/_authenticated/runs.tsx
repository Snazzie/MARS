import { createFileRoute } from "@tanstack/react-router";
import { RunsPage } from "../../routes/RunsPage.tsx";

export const Route = createFileRoute("/_authenticated/runs")({ component: RunsPage });
