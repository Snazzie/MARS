import { createFileRoute } from "@tanstack/react-router";
import { WorkerDetailPage } from "../../../routes/WorkerDetailPage.tsx";

export const Route = createFileRoute("/_authenticated/workers/$workerId")({ component: WorkerDetailPage });
