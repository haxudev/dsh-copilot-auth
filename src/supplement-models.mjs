// Non-destructive shortcut over the same manage transaction. No authorization or I/O.
import { buildModelChange } from "./model-update.mjs";

export function buildSupplementChange({ config, evidence, catalog }) {
  const raw = config.view;
  const effective = config.effectiveView ?? raw;
  const current = effective.modelsPresent && Array.isArray(effective.models) ? effective.models : [];
  const accounts = new Set(evidence.ids);
  const resolvable = new Set(catalog.resolvableIds);
  const available = [...accounts].filter((id) => resolvable.has(id));
  const currentIds = current.map((m) => m.id);
  if (current.length === 0) {
    // DSH treats models:[] and an absent models key as the complete catalog.
    // Materializing a list would narrow it and conflict with modelOverrides.
    // Preserve this mode (including inherited values and every override) verbatim.
    return {
      allowed: true, reason: null, automaticCatalog: true,
      rows: available.map((id) => ({ id, status: "listed", customized: !!effective.modelOverrides?.[id] })),
      selectedIds: available, added: [], removed: [], kept: available, warnings: [], removalClass: false,
      targetView: raw,
      overridesMeta: { rawPresent: !!raw.modelOverridesPresent, clearable: !!raw.modelOverridesPresent, inheritedOnly: !raw.modelOverridesPresent && !!effective.modelOverridesPresent },
      writeSet: { catalogEntries: catalog.newEntryCount > 0, models: false, modelOverrides: false, overridesUnclearable: false },
    };
  }
  // When the list is inherited, copy the complete effective entries with their
  // customizations, rather than replacing them with bare IDs.
  const baseline = raw.modelsPresent && Array.isArray(raw.models) && raw.models.length > 0
    ? raw : { ...raw, modelsPresent: true, models: current };
  const diff = buildModelChange({
    operation: "manage", rawView: baseline, effectiveView: effective,
    accountIds: evidence.ids, resolvableIds: catalog.resolvableIds,
    selectedIds: [...new Set([...currentIds, ...available])],
    clearOverrides: false, catalogNewEntryCount: catalog.newEntryCount ?? 0,
  });
  if (diff.targetView && diff.added.length === 0) {
    diff.targetView = raw;
    diff.writeSet.models = false;
  }
  return { ...diff, automaticCatalog: false };
}
