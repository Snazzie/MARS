import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OrganizationSettings } from "@whitesmith/contracts";
import { getSettings, updateSettings } from "../api.ts";
import { QueryState } from "../components/StateView.tsx";
import { useOrganizationFromRoute } from "./useOrganization.ts";

type Values = { maxVcpuPerPod: number; maxMemoryBytesPerPod: number; maxStorageBytesPerPod: number; maxConcurrentPods: number };
const fields: Array<[keyof Values, string, string]> = [["maxVcpuPerPod", "vCPU per pod", "Whole vCPU count"], ["maxMemoryBytesPerPod", "Memory per pod (bytes)", "Total guest RAM in bytes"], ["maxStorageBytesPerPod", "Storage per pod (bytes)", "Writable capacity in bytes"], ["maxConcurrentPods", "Maximum concurrent pods", "Positive whole number"]];
export function SettingsPage() {
  const { organizationId } = useOrganizationFromRoute();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["org", organizationId, "settings"], queryFn: () => getSettings(organizationId), enabled: Boolean(organizationId) });
  const [values, setValues] = useState<Values>({ maxVcpuPerPod: 1, maxMemoryBytesPerPod: 1, maxStorageBytesPerPod: 1, maxConcurrentPods: 1 });
  const [validation, setValidation] = useState<string[]>([]);
  useEffect(() => { if (query.data) setValues({ maxVcpuPerPod: query.data.maxVcpuPerPod, maxMemoryBytesPerPod: query.data.maxMemoryBytesPerPod, maxStorageBytesPerPod: query.data.maxStorageBytesPerPod, maxConcurrentPods: query.data.maxConcurrentPods }); }, [query.data]);
  const save = useMutation({ mutationFn: () => updateSettings(organizationId, values), onSuccess: () => { setValidation([]); void client.invalidateQueries({ queryKey: ["org", organizationId, "settings"] }); } });
  function submit(event: FormEvent) { event.preventDefault(); const parsed = OrganizationSettings.safeParse({ organizationId, ...values }); if (!parsed.success) { setValidation(parsed.error.issues.map((issue) => issue.message)); return; } setValidation([]); save.mutate(); }
}
