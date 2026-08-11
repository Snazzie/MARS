import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations } from "../api.ts";

export function useOrganizationFromRoute() {
  const organizationsQuery = useQuery({ queryKey: ["organizations"], queryFn: getOrganizations });
  const [organizationId, setOrganizationId] = useState(() => { try { return localStorage.getItem("whitesmith.organization") ?? ""; } catch { return ""; } });
  useEffect(() => { const sync = () => { try { setOrganizationId(localStorage.getItem("whitesmith.organization") ?? ""); } catch { /* storage can be disabled */ } }; window.addEventListener("whitesmith-org-change", sync); return () => window.removeEventListener("whitesmith-org-change", sync); }, []);
  useEffect(() => { if (!organizationId && organizationsQuery.data?.[0]) setOrganizationId(organizationsQuery.data[0].id); }, [organizationId, organizationsQuery.data]);
  return { organizationId, organizations: organizationsQuery.data ?? [] };
}
