import { z } from "zod";
import { RuntimePlatform, WorkerGuestPlatforms } from "./orchestration.ts";

export const TemplateGuestPlatform = z.enum(["windows-x64", "linux-x64"]);
export type TemplateGuestPlatform = z.infer<typeof TemplateGuestPlatform>;
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/i, "SHA-256 digest required");
export const TemplateManifest = z.object({
  format: z.literal(1),
  guestPlatform: TemplateGuestPlatform,
  source: z.object({ url: z.string().url(), sha256: digest }).strict(),
  template: z.object({ sha256: digest, path: z.string().min(1) }).strict(),
  hyperv: z.object({ generation: z.literal(2), secureBoot: z.boolean(), guestServiceInterface: z.literal(true) }).strict(),
  guestAgentVersion: z.string().min(1),
  preparedAt: z.string().datetime({ offset: true }),
}).strict();
export type TemplateManifest = z.infer<typeof TemplateManifest>;
export const WorkerTemplateSet = z.array(TemplateManifest).min(1).superRefine((items, ctx) => {
  const platforms = items.map(item => item.guestPlatform);
  if (new Set(platforms).size !== platforms.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate guest platform" });
});
export type WorkerTemplateSet = z.infer<typeof WorkerTemplateSet>;
export function validateTemplateSet(hostPlatform: RuntimePlatform, templates: WorkerTemplateSet): void {
  const platforms = templates.map(item => item.guestPlatform);
  const allowed = hostPlatform === "windows-x64" ? ["windows-x64", "linux-x64"] : [];
  if (hostPlatform !== "windows-x64" || platforms.some(platform => !allowed.includes(platform))) throw new Error("template guest platform is incompatible with worker host");
}
