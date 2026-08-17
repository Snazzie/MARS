import { useEffect, useState } from "react";
import type { OrganizationSummary } from "@whitesmith/contracts";

export function useOrganization(organizations: OrganizationSummary[]) {
  const [organizationId, setOrganizationIdState] = useState<string>(() => { try { return localStorage.getItem("whitesmith.organization") ?? "all"; } catch { return "all"; } });
  useEffect(() => { const sync = () => { try { setOrganizationIdState(localStorage.getItem("whitesmith.organization") ?? "all"); } catch { setOrganizationIdState("all"); } }; window.addEventListener("whitesmith-org-change", sync); return () => window.removeEventListener("whitesmith-org-change", sync); }, []);
  useEffect(() => { if (organizationId === "all" || organizations.some((organization) => organization.id === organizationId)) return; setOrganizationIdState("all"); try { localStorage.setItem("whitesmith.organization", "all"); } catch { /* storage can be disabled */ } }, [organizations, organizationId]);
  function setOrganizationId(value: string) { setOrganizationIdState(value); try { localStorage.setItem("whitesmith.organization", value); } catch { /* storage can be disabled */ } window.dispatchEvent(new Event("whitesmith-org-change")); }
  return { organizationId, setOrganizationId };
}
