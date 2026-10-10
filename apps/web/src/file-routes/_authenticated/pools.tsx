import { createFileRoute } from "@tanstack/react-router";
import { PoolsPage } from "../../routes/PoolsPage.tsx";

export const Route = createFileRoute("/_authenticated/pools")({
  component: PoolsPage,
  staticData: { navigation: { label: "Pools", order: 5, section: "primary", help: { label: "About shared pools", text: "What: global routing labels backed by compatible ready workers. How: keep labels canonical and only enable a pool after coverage is ready. Fix: disable the pool and wait for active leases before editing or deleting it." } } },
});
