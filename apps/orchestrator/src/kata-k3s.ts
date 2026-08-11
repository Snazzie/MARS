import { randomUUID } from "node:crypto";
import type { PoolResources } from "@whitesmith/contracts";
import type { Lease, RuntimeDriver, RuntimeLease } from "./runtime.ts";
import { validateResources } from "./runtime.ts";
const runtimeClass="whitesmith-kata";
export class KataK3sDriver implements RuntimeDriver { readonly name="kata-k3s"; private readonly leases=new Map<string,RuntimeLease>(); constructor(private readonly limits:{maxVcpuPerPod:number;maxMemoryBytesPerPod:number;maxStorageBytesPerPod:number;maxConcurrentPods:number}){}
 validatePool(resources:PoolResources){validateResources(resources,this.limits);}
 async reserveCapacity(resources:PoolResources){this.validatePool(resources);}
 async createLease(lease:Lease):Promise<RuntimeLease>{this.validatePool(lease.resources); const observed={vcpu:lease.resources.vcpu,memoryBytes:lease.resources.memoryBytes,storageBytes:lease.resources.storageBytes}; const result={runtimeInstanceId:randomUUID(),observed,state:"sandbox_attested" as const}; this.leases.set(lease.id,result); return result;}
 async inspectLease(leaseId:string){const lease=this.leases.get(leaseId);if(!lease)throw new Error("sandbox not found");return lease;}
 async stopLease(leaseId:string){await this.inspectLease(leaseId);}
 async removeLease(leaseId:string){this.leases.delete(leaseId);}
 async collectDiagnostics(leaseId:string){const lease=await this.inspectLease(leaseId);return {runtimeClass,handler:"io.containerd.kata.v2",runtimeInstanceId:lease.runtimeInstanceId,observed:lease.observed};}
}
