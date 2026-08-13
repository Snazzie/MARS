import { useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { ApiRequestError, mutateWorker } from "../api.ts";

type Action = "reject" | "drain" | "remove";
const copy: Record<Action, { label: string; confirm: string; variant: "primary" | "secondary" | "destructive" }> = {
  reject: { label: "Reject", confirm: "Reject this worker? Its enrollment will be revoked and it will not receive work.", variant: "destructive" },
  drain: { label: "Drain", confirm: "Drain this worker? New leases will stop while active work completes.", variant: "secondary" },
  remove: { label: "Remove", confirm: "Remove this worker? Pools will be disabled and the worker will be revoked after active leases finish.", variant: "destructive" },
};

export function WorkerActions({ organizationId, workerId, admissionState, draining, onComplete }: { organizationId: string; workerId: string; admissionState: string; draining: boolean; onComplete: () => void }) {
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  function open(next: Action) { setError(null); setAction(next); dialog.current?.showModal(); }
  function close() { dialog.current?.close(); setAction(null); }
  async function confirm() {
    if (!action) return;
    setPending(true); setError(null);
    try { await mutateWorker(organizationId, workerId, action); close(); onComplete(); }
    catch (reason) { setError(reason instanceof ApiRequestError ? reason.message : "The action could not be completed."); }
    finally { setPending(false); }
  }
  return <>
    <div className="worker-actions" aria-label="Worker actions">
      {admissionState === "pending" && <Button label="Reject" variant="destructive" clickAction={() => open("reject")} />}
      {admissionState === "adopted" && <><Button label={draining ? "Draining" : "Drain"} variant="secondary" isDisabled={draining} clickAction={() => open("drain")} /><Button label="Remove" variant="destructive" clickAction={() => open("remove")} /></>}
    </div>
    <dialog ref={dialog} className="confirm-dialog" onCancel={close} aria-labelledby="worker-confirm-title">
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        <p className="panel-kicker">Confirm action</p><h2 id="worker-confirm-title">{action ? copy[action].label : "Worker action"}</h2><p>{action ? copy[action].confirm : ""}</p>
        {error && <p className="inline-error" role="alert">{error}</p>}
        <div className="dialog-actions"><Button label="Cancel" variant="secondary" onClick={close} isDisabled={pending} /><Button label={action ? copy[action].label : "Confirm"} variant={action ? copy[action].variant : "primary"} type="submit" isLoading={pending} /></div>
      </form>
    </dialog>
  </>;
}
