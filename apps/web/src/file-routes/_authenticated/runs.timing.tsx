import { createFileRoute } from "@tanstack/react-router";
import { TimingHistoryPage } from "../../routes/TimingHistoryPage.tsx";

export const Route = createFileRoute("/_authenticated/runs/timing")({ component: TimingHistoryPage });
