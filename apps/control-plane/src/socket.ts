import { randomBytes } from "node:crypto";
import { verifyWorkerSignature } from "./workers.ts";
export type SocketActor = "worker"|"job-agent"|"browser";
export interface SocketSession { actor:SocketActor; workerId?:string; leaseId?:string; nonce:Buffer; authenticated:boolean; }
export function beginWorkerHandshake(): SocketSession { return {actor:"worker",nonce:randomBytes(32),authenticated:false}; }
export function authenticateWorker(session:SocketSession, publicKey:string, signature:Buffer):void { if(session.actor!=="worker" || !verifyWorkerSignature(publicKey,session.nonce,signature)) throw new Error("worker authentication failed"); session.authenticated=true; }
export function authorizeJobFrame(session:SocketSession, leaseId:string):void { if(session.actor!=="job-agent" || !session.authenticated || session.leaseId!==leaseId) throw new Error("job frame outside lease"); }
