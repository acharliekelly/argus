import { isAbsolute, join } from 'node:path';

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

  const home = absolutePath(environment.HOME);
  const configRoot = absolutePath(environment.XDG_CONFIG_HOME) ?? (home && join(home, '.config'));
  const dataRoot =
    absolutePath(environment.XDG_DATA_HOME) ?? (home && join(home, '.local', 'share'));
  if (!configRoot || !dataRoot) {
    throw new Error('Absolute config and data roots are required');
  }

  return {
    profilePath: join(configRoot, 'argus', 'sites', `${name}.json`),
    dataRoot: join(dataRoot, 'argus', 'sites', name)
  };
}

function absolutePath(path: string | undefined): string | undefined {
  return path && isAbsolute(path) ? path : undefined;
}
