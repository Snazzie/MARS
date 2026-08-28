type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly DEV?: boolean;
  };
};

/** Returns Vite's build-time mode without requiring vite/client types in Bun. */
export function isLocalDevelopment(): boolean {
  const viteDev = (import.meta as ViteImportMeta).env?.DEV;
  if (typeof viteDev === "boolean") return viteDev;
  return typeof Bun !== "undefined" && Bun.env.NODE_ENV === "development";
}
