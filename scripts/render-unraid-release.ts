import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type ReleaseOptions = {
  appVersion: string;
  appImage: string;
  postgresImage: string;
  cloudflaredImage: string;
};

const root = fileURLToPath(new URL("..", import.meta.url));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const digestImage = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

function assertOptions(options: ReleaseOptions) {
  if (!semver.test(options.appVersion)) throw new Error(`appVersion must be SemVer: ${options.appVersion}`);
  for (const [name, image] of Object.entries({ appImage: options.appImage, postgresImage: options.postgresImage, cloudflaredImage: options.cloudflaredImage })) {
    if (!digestImage.test(image)) throw new Error(`${name} must be repository@sha256:<64 lowercase hex>`);
  }
}

const templates = [
  ["mars-control-plane.template.xml", "mars-control-plane", "__MARS_CONTROL_PLANE_IMAGE__", "appImage"],
  ["mars-postgres.template.xml", "mars-postgres", "__POSTGRES_IMAGE__", "postgresImage"],
  ["mars-cloudflared.template.xml", "mars-cloudflared", "__CLOUDFLARED_IMAGE__", "cloudflaredImage"],
] as const;
export function renderUnraidReleaseAssets(options: ReleaseOptions): Record<string, string> {
  assertOptions(options);
  const values = { appImage: options.appImage, postgresImage: options.postgresImage, cloudflaredImage: options.cloudflaredImage };
  const output: Record<string, string> = {};
  for (const [templateName, basename, placeholder, key] of templates) {
    const source = readFileSync(join(root, "deploy/unraid", templateName), "utf8");
    const count = source.split(placeholder).length - 1;
    if (count !== 1) throw new Error(`${templateName} must contain exactly one ${placeholder}`);
    const rendered = source.replace(placeholder, values[key]);
    if (/__[^\\s<]+__/.test(rendered)) throw new Error(`${templateName} contains an unresolved placeholder`);
    output[`${basename}-v${options.appVersion}.xml`] = rendered;
  }
  return output;
}

function arg(name: string) {
  const index = Bun.argv.indexOf(name);
  if (index < 0 || !Bun.argv[index + 1]) throw new Error(`missing ${name}`);
  return Bun.argv[index + 1];
}

if (import.meta.main) {
  try {
    const outDir = arg("--out-dir");
    const assets = renderUnraidReleaseAssets({
      appVersion: arg("--app-version"),
      appImage: arg("--app-image"),
      postgresImage: arg("--postgres-image"),
      cloudflaredImage: arg("--cloudflared-image"),
    });
    mkdirSync(outDir, { recursive: true });
    for (const [name, contents] of Object.entries(assets)) writeFileSync(join(outDir, name), contents);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
