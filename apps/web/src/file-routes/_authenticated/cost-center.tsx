import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CostCenterPage } from "../../routes/CostCenterPage.tsx";

export const Route = createFileRoute("/_authenticated/cost-center")({
  validateSearch: z.object({ period: z.enum(["24h", "7d", "30d"]).catch("24h"), provider: z.enum(["github", "blacksmith", "azure-vm"]).catch("github") }).default({ period: "24h", provider: "github" }),
  component: CostCenterPage,
});
