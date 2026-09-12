import { Outlet, createFileRoute } from "@tanstack/react-router";

function WorkersLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/_authenticated/workers")({ component: WorkersLayout });
