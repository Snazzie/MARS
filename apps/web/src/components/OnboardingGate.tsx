import { Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getOnboardingStatus } from "../api.ts";

export function OnboardingGate() {
  const location = useLocation();
  const status = useQuery({ queryKey: ["onboarding-status"], queryFn: getOnboardingStatus, staleTime: 1000 });
  if (status.isLoading || status.error || !status.data) return <Outlet />;
  if (status.data.onboardingRequired && location.pathname !== "/onboarding") return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}
