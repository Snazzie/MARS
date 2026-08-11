import { createDb, migrate } from "@whitesmith/db";
import { createSession, getSession, SecretBox } from "./auth.ts";
import { createPkce, githubAuthorizeUrl, exchangeOAuth, ensureBootstrapAdmin } from "./github.ts";
import { readBody, validSignature, acceptDelivery } from "./webhook.ts";
import { createEnrollmentCode, consumeJoin, fingerprint, adoptWorker } from "./workers.ts";

const required = (name:string):string => { const value=Bun.env[name]; if(!value) throw new Error(`${name} is required`); return value; };
const env = { BASE: required("PUBLIC_BASE_URL"), DATABASE: required("DATABASE_URL"), WEBHOOK_SECRET: required("GITHUB_WEBHOOK_SECRET"), CLIENT_ID: required("GITHUB_OAUTH_CLIENT_ID"), CLIENT_SECRET: required("GITHUB_OAUTH_CLIENT_SECRET"), BOOTSTRAP: required("BOOTSTRAP_GITHUB_LOGIN"), MASTER: required("APP_MASTER_KEY") };
const db = createDb(env.DATABASE); await migrate(db); new SecretBox(env.MASTER);
const json = (data: unknown, status=200) => Response.json(data,{status,headers:{"cache-control":"no-store"}});
const cookie = (value:string, maxAge:number) => `whitesmith_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const sessions = new Map<string, {state:string; verifier:string; createdAt:number}>();
async function current(request: Request) { return getSession(db, request.headers.get("cookie")?.match(/whitesmith_session=([^;]+)/)?.[1]); }
const server = Bun.serve({ port: Number(Bun.env.PORT ?? 3000), websocket: { open(ws){ ws.subscribe("browser"); }, message(ws,message){ if(message === "ping") ws.send("pong"); }, close(ws){ ws.unsubscribe("browser"); } }, async fetch(request) {
  const url=new URL(request.url); try {
    if(request.method === "GET" && ["/","/index.html"].includes(url.pathname)) return new Response(Bun.file(new URL("../../web/index.html", import.meta.url)));
    if(request.method === "GET" && url.pathname === "/index.js") return new Response(Bun.file(new URL("../../web/dist/index.js", import.meta.url)));
    if(request.method === "GET" && url.pathname === "/styles.css") return new Response(Bun.file(new URL("../../web/src/styles.css", import.meta.url)));
    if(request.method === "GET" && url.pathname === "/healthz") return json({ok:true});
    if(request.method === "GET" && url.pathname === "/api/auth/github") { const flow=createPkce(); sessions.set(flow.state,flow); return new Response(null,{status:302,headers:{location:githubAuthorizeUrl(env.BASE,env.CLIENT_ID,flow),"set-cookie":`oauth_state=${flow.state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=600`}}); }
    if(request.method === "GET" && url.pathname === "/api/auth/github/callback") { const state=url.searchParams.get("state") ?? ""; const flow=sessions.get(state); sessions.delete(state); if(!flow || request.headers.get("cookie")?.includes(`oauth_state=${state}`) !== true) return json({error:"invalid oauth state"},400); const user=await exchangeOAuth(url.searchParams.get("code") ?? "",flow,env.CLIENT_ID,env.CLIENT_SECRET,env.BASE); const [row]=await db`insert into users (github_user_id,login) values (${user.id},${user.login}) on conflict (github_user_id) do update set login=excluded.login returning id,is_global_admin`; if(user.login.toLowerCase()===env.BOOTSTRAP.toLowerCase() && !row.is_global_admin) await ensureBootstrapAdmin(db,user.id,user.login,env.BOOTSTRAP); const token=await createSession(db,String(row.id)); return new Response(null,{status:302,headers:{location:"/", "set-cookie":cookie(token,604800)}}); }
    if(request.method === "POST" && url.pathname === "/api/github/webhooks") { const body=await readBody(request); if(!validSignature(body,request.headers.get("x-hub-signature-256"),env.WEBHOOK_SECRET)) return json({error:"invalid signature"},401); const payload=JSON.parse(body.toString()); const installationId=Number(payload.installation?.id ?? 0); const accepted=await acceptDelivery(db,request.headers.get("x-github-delivery") ?? crypto.randomUUID(),installationId,payload); return json({accepted},202); }
    if(request.method === "POST" && url.pathname === "/api/workers/join") { const body=await request.json() as {code:string;publicKey:string;platform:string;vmUuid:string;limits:Record<string,number>}; if(!await consumeJoin(db,Buffer.from(body.code,"base64url"))) return json({error:"invalid or expired join"},401); const [worker]=await db`insert into workers (name,platform,admission_state,public_key,fingerprint,vm_uuid,limits) values (${body.vmUuid},${body.platform},'pending',${body.publicKey},${fingerprint(body.publicKey)},${body.vmUuid},${JSON.stringify(body.limits)}) returning id,fingerprint`; return json({workerId:worker.id,fingerprint:worker.fingerprint},201); }
    const user=await current(request); if(!user) return json({error:"unauthorized"},401);
    if(request.method === "GET" && url.pathname === "/api/me") return json(user);
    if(request.method === "GET" && url.pathname === "/api/workers") return json(await db`select id,name,platform,admission_state as "admissionState",connection_state as "connectionState",configuration_state as "configurationState",fingerprint,limits,doctor from workers order by created_at desc`);
    if(request.method === "POST" && url.pathname === "/api/workers/enroll") { if(!user.isGlobalAdmin) return json({error:"forbidden"},403); const body=await request.json() as {audience:string; profile:Record<string,number>}; const enrollment=createEnrollmentCode(); await db`insert into worker_join_codes (guest_token_hash,status_token_hash,audience,requested_profile,canonical_base_url,expires_at) values (${enrollment.guestHash},${enrollment.statusHash},${body.audience},${JSON.stringify(body.profile)},${env.BASE},${enrollment.expiresAt})`; return json({code:enrollment.code,expiresAt:enrollment.expiresAt.toISOString(),installer:`${env.BASE}/api/workers/installer?audience=${encodeURIComponent(body.audience)}`},201); }
    if(request.method === "POST" && /^\/api\/workers\/[0-9a-f-]+\/adopt$/.test(url.pathname)) { if(!user.isGlobalAdmin) return json({error:"forbidden"},403); await adoptWorker(db,url.pathname.split("/")[3],user.id); return json({ok:true}); }
    return json({error:"not found"},404);
  } catch(error) { console.error(error); return json({error:error instanceof Error?error.message:"internal error"},500); }
}});
console.log(`Whitesmith control plane listening on ${server.url}`);
