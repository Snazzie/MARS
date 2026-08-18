import { PoolResources, type RuntimeTerminationEvidence } from "@whitesmith/contracts";
export interface Lease { id:string; jobId:string; imageDigest:string; resources:PoolResources; nonce:string; encodedJitConfig:string; }
export interface RuntimeLease {
  runtimeInstanceId:string;
  observed:{vcpu:number;memoryBytes:number;storageBytes:number};
  state:"sandbox_attested"|"failed";
  completion?: Promise<number>;
  logs?: AsyncIterable<string>;
  sample?: () => Promise<{ cpuUsagePercent:number; cpuTimeMs:number; memoryWorkingSetBytes:number; memoryLimitBytes:number }>;
  termination?: RuntimeTerminationEvidence;
  correlationId?: string;
}
export interface RuntimeDriver { readonly name:string; validatePool(resources:PoolResources):void; reserveCapacity(resources:PoolResources):Promise<void>; createLease(lease:Lease):Promise<RuntimeLease>; inspectLease(leaseId:string):Promise<RuntimeLease>; requestGracefulStop?(leaseId:string, reason:"out_of_memory", message:string):Promise<boolean>; stopLease(leaseId:string):Promise<void>; removeLease(leaseId:string):Promise<void>; collectDiagnostics(leaseId:string):Promise<Record<string,unknown>>; collectRawDiagnostics?(leaseId:string):Promise<string>; }
export function validateResources(resources:PoolResources, limits:{maxVcpuPerPod:number;maxMemoryBytesPerPod:number;maxStorageBytesPerPod:number;maxConcurrentPods:number}):void { if(resources.vcpu>limits.maxVcpuPerPod||resources.memoryBytes>limits.maxMemoryBytesPerPod||resources.storageBytes>limits.maxStorageBytesPerPod||resources.concurrency>limits.maxConcurrentPods) throw new Error("resource ceiling exceeded"); }
