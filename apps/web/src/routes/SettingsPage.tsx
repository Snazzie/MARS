import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OrganizationSettings } from "@whitesmith/contracts";
import { getSettings, updateSettings } from "../api.ts";
import { QueryState, WorkspaceRequired } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";
type Values = { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
const fields: Array<[keyof Values, string, string]> = [["maxVcpuPerPod", "vCPU per pod", "Whole vCPU count"], ["maxMemoryBytesPerPod", "Memory per pod (bytes)", "Total guest RAM in bytes"], ["maxStorageBytesPerPod", "Storage per pod (bytes)", "Writable capacity in bytes"], ["maxConcurrentPods", "Maximum concurrent pods", "Positive whole number"]];
export function SettingsPage() {
  const { organizationId } = useOrganizationFromRoute();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["org", organizationId, "settings"], queryFn: () => getSettings(organizationId), enabled: organizationId !== "all" });
  const [values, setValues] = useState<Values>({ maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 });
  const [validation, setValidation] = useState<string[]>([]);
  useEffect(() => { if (query.data) setValues({ maxVcpuPerPod: query.data.maxVcpuPerPod, maxMemoryBytesPerPod: query.data.maxMemoryBytesPerPod, maxStorageBytesPerPod: query.data.maxStorageBytesPerPod, maxConcurrentPods: query.data.maxConcurrentPods }); }, [query.data]);
  const save = useMutation({ mutationFn: () => updateSettings(organizationId, values), onSuccess: () => { setValidation([]); void client.invalidateQueries({ queryKey: ["org", organizationId, "settings"] }); } });
  function submit(event: FormEvent) { event.preventDefault(); const parsed = OrganizationSettings.safeParse({ organizationId, ...values }); if (!parsed.success) { setValidation(parsed.error.issues.map((issue) => issue.message)); return; } setValidation([]); save.mutate(); }
  if (organizationId === "all") return <WorkspaceRequired />;
  return <><header className="page-header"><div><p className="eyebrow">Organization settings</p><h1>Set the fleet safety envelope.</h1><p className="page-description">These hard per-pod ceilings limit every runner pool in the selected organization.</p></div></header><QueryState error={query.error} isLoading={query.isLoading} retry={() => void query.refetch()} />{query.data && <form className="settings-form" onSubmit={submit}><fieldset disabled={save.isPending}><legend>Maximum runner resources</legend>{fields.map(([name, label, description]) => <label key={name}>{label}<input type="number" min={1} step={1} required value={values[name]} onChange={(event) => setValues((current) => ({ ...current, [name]: Number(event.target.value) }))} /><small>{description}</small></label>)}</fieldset>{validation.length > 0 && <div className="form-error" role="alert"><strong>Correct these values:</strong><ul>{validation.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}</ul></div>}{save.error && <p className="form-error" role="alert">{save.error instanceof Error ? save.error.message : "Settings update failed."}</p>}<button className="control-button" type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save settings"}</button></form>}</>;
}
