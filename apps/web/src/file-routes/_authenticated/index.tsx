import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "../../routes/OverviewPage.tsx";

export const Route = createFileRoute("/_authenticated/")({ component: OverviewPage });
