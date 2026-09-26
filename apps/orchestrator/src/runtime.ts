import { PoolResources, type CpuMode, type GuestPlatform, type RuntimeTerminationEvidence, type WorkerCacheProxy } from "@mars/contracts";
export interface Lease { id:string; jobId:string; contractVersion:string; guestPlatform?: GuestPlatform; imageDigest:string; resources:PoolResources; cpuMode?:CpuMode; cpuIds?:number[]; nonce:string; encodedJitConfig:string; workerCache?: WorkerCacheProxy; }
export function assertUnpinnedLease(lease: Lease): void {
  if (lease.cpuIds !== undefined) throw new Error("unpinned worker cannot claim host CPU IDs");
}
export interface RuntimeLease {
  runtimeInstanceId:string;
  observed:{vcpu:number;memoryBytes:number;storageBytes:number};
  state:"sandbox_attested"|"failed";
  completion?: Promise<number>;
  logs?: AsyncIterable<string>;
  sample?: () => Promise<{ cpuUsagePercent:number; cpuTimeMs:number; memoryWorkingSetBytes:number; memoryLimitBytes:number; diskUsageBytes?:number }>;
  termination?: RuntimeTerminationEvidence;
  correlationId?: string;
}
export interface RuntimeDriver { readonly name:string; validatePool(resources:PoolResources):void; reserveCapacity(resources:PoolResources):Promise<void>; createLease(lease:Lease):Promise<RuntimeLease>; inspectLease(leaseId:string):Promise<RuntimeLease>; requestGracefulStop?(leaseId:string, reason:"out_of_memory", message:string):Promise<boolean>; stopLease(leaseId:string):Promise<void>; removeLease(leaseId:string):Promise<void>; collectDiagnostics(leaseId:string):Promise<Record<string,unknown>>; collectRawDiagnostics?(leaseId:string):Promise<string>; }
export function validateResources(resources:PoolResources, limits:{maxVcpuPerPod:number;maxMemoryBytesPerPod:number;maxStorageBytesPerPod:number;maxConcurrentPods:number}):void { if(resources.vcpu>limits.maxVcpuPerPod||resources.memoryBytes>limits.maxMemoryBytesPerPod||resources.storageBytes>limits.maxStorageBytesPerPod||resources.concurrency>limits.maxConcurrentPods) throw new Error("resource ceiling exceeded"); }
