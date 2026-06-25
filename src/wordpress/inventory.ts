import type { ExtensionInventory, SiteInventory, UpdateTarget } from '../types.js';

type WpCliExtension = {
  name: string;
  status: string;
  version: string;
  update?: string;
  update_version?: string;
};

type WpCliCoreUpdate = {
  version: string;
};

export function normalizeExtensionInventory(rows: WpCliExtension[]): ExtensionInventory[] {
  return rows.map((row) => ({
    slug: row.name,
    status: row.status,
    version: row.version,
    updateVersion:
      row.update === 'available' && row.update_version ? row.update_version : null
  }));
}

export function normalizeCoreInventory(
  version: string,
  updates: WpCliCoreUpdate[]
): SiteInventory['core'] {
  return {
    version,
    updateVersion: updates[0]?.version ?? null
  };
}

export function assertUpdateEligible(
  inventory: SiteInventory,
  target: UpdateTarget
): ExtensionInventory {
  if (target.type === 'core') {
    throw new Error('unsupported_target: WordPress core is managed by the Compose image');
  }

  const components = target.type === 'plugin' ? inventory.plugins : inventory.themes;
  const component = components.find(({ slug }) => slug === target.slug);
  if (!component) {
    throw new Error(`component_not_found: ${target.type} ${target.slug}`);
  }
  if (!component.updateVersion) {
    throw new Error(`no_update_available: ${target.type} ${target.slug}`);
  }
  return component;
}
