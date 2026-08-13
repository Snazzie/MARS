import type { RuntimePlatform, WorkerDoctor as WorkerDoctorDto } from "@whitesmith/contracts";

type CheckKey = keyof Pick<WorkerDoctorDto, "nestedKvm" | "kvmModules" | "probe" | "egress" | "imageSignatures" | "blockVolume">;
type Check = { key: CheckKey; label: string; platforms: RuntimePlatform[] };
const checks: Check[] = [
  { key: "nestedKvm", label: "Nested KVM", platforms: ["linux-x64"] },
  { key: "kvmModules", label: "KVM and vhost modules", platforms: ["linux-x64"] },
  { key: "probe", label: "Disposable Kata probe", platforms: ["linux-x64"] },
  { key: "egress", label: "Public egress", platforms: ["linux-x64", "windows-x64", "macos-arm64"] },
  { key: "imageSignatures", label: "Image signatures", platforms: ["linux-x64"] },
  { key: "blockVolume", label: "Block volume support", platforms: ["linux-x64"] },
];
export function WorkerDoctor({ doctor, platform }: { doctor: WorkerDoctorDto | null; platform: RuntimePlatform }) {
  if (!doctor) return <section className="doctor-panel"><div className="panel-kicker">Runtime doctor</div><p className="muted">No doctor report yet. Save limits after adoption to enable dispatch.</p></section>;
  const visibleChecks = checks.filter((check) => check.platforms.includes(platform));
  const failedChecks = visibleChecks.filter(({ key }) => doctor[key] === false).length;
  const handlerFailed = platform === "linux-x64" && doctor.runtimeHandler !== undefined && doctor.runtimeHandler !== "kata-qemu-runtime-rs";
  const failed = failedChecks + (handlerFailed ? 1 : 0);
  return <section className="doctor-panel" aria-labelledby="doctor-title"><div className="panel-heading"><div><div className="panel-kicker">Runtime doctor</div><h3 id="doctor-title">{failed ? "Remediation required" : "Ready for dispatch"}</h3></div><span className={`status-pill ${failed ? "status-bad" : "status-good"}`}>{failed ? `${failed} checks need attention` : "Observed checks pass"}</span></div><ul className="doctor-checks">{visibleChecks.map(({ key, label }) => { const known = typeof doctor[key] === "boolean"; const passed = doctor[key] === true; return <li key={key} className={known ? (passed ? "check-pass" : "check-fail") : "check-unknown"}><span aria-hidden="true">{known ? (passed ? "✓" : "×") : "?"}</span><span>{label}</span><strong>{known ? (passed ? "Pass" : "Fail") : "Unknown"}</strong></li>; })}{platform === "linux-x64" && doctor.runtimeHandler !== undefined && <li className={handlerFailed ? "check-fail" : "check-pass"}><span aria-hidden="true">{handlerFailed ? "×" : "✓"}</span><span>Runtime handler</span><strong>{handlerFailed ? doctor.runtimeHandler : "kata-qemu-runtime-rs"}</strong></li>}</ul></section>;
}
