import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations } from "../api.ts";

export function useOrganizationFromRoute() {
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations });
  const [organizationId, setOrganizationId] = useState(() => { try { return localStorage.getItem("mars.organization") ?? "all"; } catch { return "all"; } });
  useEffect(() => { const sync = () => { try { setOrganizationId(localStorage.getItem("mars.organization") ?? "all"); } catch { setOrganizationId("all"); } }; window.addEventListener("mars-org-change", sync); return () => window.removeEventListener("mars-org-change", sync); }, []);
  useEffect(() => {
    if (organizationsQuery.isLoading) return;
    const available = organizationsQuery.data ?? [];
    if (organizationId === "all" || available.some((organization) => organization.id === organizationId)) return;
    setOrganizationId("all");
    try { localStorage.setItem("mars.organization", "all"); } catch { /* storage can be disabled */ }
    window.dispatchEvent(new Event("mars-org-change"));
  }, [organizationId, organizationsQuery.data]);
  return { organizationId, organizations: organizationsQuery.data ?? [] };
}
