import { useEffect, useState } from "react";
import type { OrganizationSummary } from "@mars/contracts";

export function useOrganization(organizations: OrganizationSummary[]) {
  const [organizationId, setOrganizationIdState] = useState<string>(() => { try { return localStorage.getItem("mars.organization") ?? "all"; } catch { return "all"; } });
  useEffect(() => { const sync = () => { try { setOrganizationIdState(localStorage.getItem("mars.organization") ?? "all"); } catch { setOrganizationIdState("all"); } }; window.addEventListener("mars-org-change", sync); return () => window.removeEventListener("mars-org-change", sync); }, []);
  useEffect(() => { if (organizationId === "all" || organizations.some((organization) => organization.id === organizationId)) return; setOrganizationIdState("all"); try { localStorage.setItem("mars.organization", "all"); } catch { /* storage can be disabled */ } }, [organizations, organizationId]);
  function setOrganizationId(value: string) { setOrganizationIdState(value); try { localStorage.setItem("mars.organization", value); } catch { /* storage can be disabled */ } window.dispatchEvent(new Event("mars-org-change")); }
  return { organizationId, setOrganizationId };
}
