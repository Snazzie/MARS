import { startControlPlane } from "../apps/control-plane/src/index.ts";
import { devWindowsImageBuild, devWorkerEnrollmentAdapter } from "./dev-worker-join.ts";

if (Bun.env.NODE_ENV === "production") throw new Error("Development control plane cannot run with NODE_ENV=production");
const token = Bun.env.MARS_DEV_TOKEN?.trim();
if (!token) throw new Error("MARS_DEV_TOKEN is required for development worker enrollment");

await startControlPlane({
  workerJoin: devWorkerEnrollmentAdapter(token),
  devWindowsImageBuild,
  disableWorkerBootstrapManagement: true,
});
