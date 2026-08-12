import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations } from "../api.ts";

export function useOrganizationFromRoute() {
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations });
  const [organizationId, setOrganizationId] = useState(() => { try { return localStorage.getItem("whitesmith.organization") ?? "all"; } catch { return "all"; } });
  useEffect(() => { const sync = () => { try { setOrganizationId(localStorage.getItem("whitesmith.organization") ?? "all"); } catch { setOrganizationId("all"); } }; window.addEventListener("whitesmith-org-change", sync); return () => window.removeEventListener("whitesmith-org-change", sync); }, []);
  useEffect(() => {
    if (organizationsQuery.isLoading) return;
    const available = organizationsQuery.data ?? [];
    if (organizationId === "all" || available.some((organization) => organization.id === organizationId)) return;
    setOrganizationId("all");
    try { localStorage.setItem("whitesmith.organization", "all"); } catch { /* storage can be disabled */ }
    window.dispatchEvent(new Event("whitesmith-org-change"));
  }, [organizationId, organizationsQuery.data]);
  return { organizationId, organizations: organizationsQuery.data ?? [] };
}
