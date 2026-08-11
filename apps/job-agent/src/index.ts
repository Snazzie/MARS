import { createHash } from "node:crypto";
function hash(value:Buffer):string{return createHash("sha256").update(value).digest("hex");}
if(Bun.argv[2] !== "accept-claim" || !Bun.argv.includes("--stdin")) throw new Error("usage: whitesmith-job-agent accept-claim --stdin");
const claim=Buffer.from(await Bun.stdin.bytes()); if(claim.length < 32) throw new Error("claim missing");
console.log(JSON.stringify({accepted:true,claimHash:hash(claim)})); claim.fill(0);
