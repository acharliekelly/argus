import { join } from 'node:path';

export const SITE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type SitePaths = {
  profilePath: string;
  dataRoot: string;
};

export function assertSiteName(name: string): void {
  if (!SITE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid site name: ${name}`);
  }
}

export function resolveSitePaths(
  name: string,
  environment: NodeJS.ProcessEnv = process.env
): SitePaths {
  assertSiteName(name);

  const home = environment.HOME;
  const configRoot = environment.XDG_CONFIG_HOME || (home && join(home, '.config'));
  const dataRoot = environment.XDG_DATA_HOME || (home && join(home, '.local', 'share'));
  if (!configRoot || !dataRoot) {
    throw new Error('HOME is required when XDG config or data directories are not set');
  }

  return {
    profilePath: join(configRoot, 'argus', 'sites', `${name}.json`),
    dataRoot: join(dataRoot, 'argus', 'sites', name)
  };
}
