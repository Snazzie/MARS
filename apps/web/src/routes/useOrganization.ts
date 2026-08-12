import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations } from "../api.ts";

export function useOrganizationFromRoute() {
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations });
  const [organizationId, setOrganizationId] = useState(() => { try { return localStorage.getItem("whitesmith.organization") ?? ""; } catch { return ""; } });
  useEffect(() => { const sync = () => { try { setOrganizationId(localStorage.getItem("whitesmith.organization") ?? ""); } catch { /* storage can be disabled */ } }; window.addEventListener("whitesmith-org-change", sync); return () => window.removeEventListener("whitesmith-org-change", sync); }, []);
  useEffect(() => {
    if (organizationsQuery.isLoading) return;
    const available = organizationsQuery.data ?? [];
    const valid = available.some((organization) => organization.id === organizationId);
    if (valid) return;
    const next = available[0]?.id ?? "";
    setOrganizationId(next);
    try {
      if (next) localStorage.setItem("whitesmith.organization", next);
      else localStorage.removeItem("whitesmith.organization");
    } catch { /* storage can be disabled */ }
    window.dispatchEvent(new Event("whitesmith-org-change"));
  }, [organizationId, organizationsQuery.data]);
  return { organizationId, organizations: organizationsQuery.data ?? [] };
}
