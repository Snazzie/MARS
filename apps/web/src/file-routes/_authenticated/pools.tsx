import { createFileRoute } from "@tanstack/react-router";
import { PoolsPage } from "../../routes/PoolsPage.tsx";

export const Route = createFileRoute("/_authenticated/pools")({ component: PoolsPage });
