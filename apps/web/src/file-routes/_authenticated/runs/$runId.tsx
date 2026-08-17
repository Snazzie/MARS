import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { RunDetailPage } from "../../../routes/RunDetailPage.tsx";

export const Route = createFileRoute("/_authenticated/runs/$runId")({
  validateSearch: z.object({ organizationId: z.string().optional() }),
  component: RunDetailPage,
});
