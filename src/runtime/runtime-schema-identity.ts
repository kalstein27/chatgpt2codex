import type { RuntimeManifest } from "./runtime-manifest.js";

type SchemaIdentity = Partial<Pick<RuntimeManifest, "toolSchemaRevision" | "hostCatalogRevision" | "uiResourceRevision">>;

/** Unknown legacy revisions cannot establish equality with a known new one. */
export function runtimeSchemaRefreshRequired(previous: SchemaIdentity, target: SchemaIdentity): boolean {
  return (["toolSchemaRevision", "hostCatalogRevision", "uiResourceRevision"] as const)
    .some((key) => (previous[key] ?? null) !== (target[key] ?? null));
}

export function runtimeGenerationMatches(target: RuntimeManifest, current: RuntimeManifest): boolean {
  if (!target.runtimeFingerprint || !current.runtimeFingerprint || target.runtimeFingerprint !== current.runtimeFingerprint) return false;
  return (["toolSchemaRevision", "hostCatalogRevision", "uiResourceRevision"] as const)
    .every((key) => !target[key] || !current[key] || target[key] === current[key]);
}
