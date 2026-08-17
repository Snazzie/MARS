import { createFileRoute } from "@tanstack/react-router";
import { WorkersPage } from "../../routes/WorkersPage.tsx";

export const Route = createFileRoute("/_authenticated/workers")({ component: WorkersPage });
