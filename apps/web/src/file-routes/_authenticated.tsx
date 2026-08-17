import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getOnboardingStatus } from "../api.ts";
import { requireAuthentication } from "../auth.ts";
import { AppShell } from "../components/AppShell.tsx";

function AuthenticatedLayout() {
  const status = useQuery({ queryKey: ["onboarding-status"], queryFn: getOnboardingStatus, staleTime: 1000 });
  if (status.isLoading || !status.data) return null;
  if (status.data.onboardingRequired) return <Navigate to="/onboarding" replace />;
  return <AppShell />;
}

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: requireAuthentication,
  component: AuthenticatedLayout,
});
