import type { Page } from 'playwright';

export type UpdateTarget = {
  type: 'plugin' | 'theme' | 'core';
  slug: string;
};

export type ExtensionInventory = {
  slug: string;
  status: string;
  version: string;
  updateVersion: string | null;
};

export type SiteInventory = {
  core: {
    version: string;
    updateVersion: string | null;
  };
  plugins: ExtensionInventory[];
  themes: ExtensionInventory[];
};

export type CommandRecord = {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type ScenarioContext = {
  baseUrl: string;
  secrets: Record<string, string>;
};

export type ScenarioDefinition = {
  name: string;
  path: string;
  visualThreshold?: number;
  mask?: string[];
  visibleSelectors?: string[];
  run?: (page: Page, context: ScenarioContext) => Promise<void>;
};

export type ViewportDefinition = {
  name: string;
  width: number;
  height: number;
};

export type SiteIdentity = {
  name: string;
  fingerprint: string;
};
