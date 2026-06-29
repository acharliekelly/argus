import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { assertCommandPassed } from '../process.js';
import type { DiscoveredSite, DiscoverSiteInput } from './discovery.js';
import { discoverSite as defaultDiscoverSite } from './discovery.js';
import type { DockerSiteHelper } from './helper.js';
import { DockerSiteHelper as DefaultDockerSiteHelper } from './helper.js';
import { resolveSitePaths } from './paths.js';
import type { SiteProfile } from './profile.js';
import { SiteStore } from './store.js';

export type ConnectSiteInput = {
  name: string;
  composeFile: string;
  wordpressService?: string | undefined;
  baseUrl?: string | undefined;
  force?: boolean;
};

export type ConnectSiteDependencies = {
  discoverSite(input: DiscoverSiteInput): Promise<DiscoveredSite>;
  createHelper(site: {
    containerId: string;
    networkName: string;
    wordpressEnvironment: Record<string, string>;
  }): Pick<DockerSiteHelper, 'runWp'>;
  fetch(url: string): Promise<{ ok: boolean; status: number }>;
  store: SiteStore;
  environment?: NodeJS.ProcessEnv;
};

export type ConnectSiteResult = {
  profile: SiteProfile;
  summary: {
    profilePath: string;
    artifactRoot: string;
    composeProject: string;
    wordpressService: string;
    baseUrl: string;
    wordpressMount: string;
    networkName: string;
    helperImage: string;
  };
};

export async function connectSite(
  _input: ConnectSiteInput,
  _dependencies?: Partial<ConnectSiteDependencies>
): Promise<ConnectSiteResult> {
  const input = _input;
  const dependencies = resolveDependencies(_dependencies);
  const discovered = await dependencies.discoverSite(discoveryInput(input));
  const helper = dependencies.createHelper({
    containerId: discovered.containerId,
    networkName: discovered.networkName,
    wordpressEnvironment: discovered.wordpressEnvironment
  });

  assertCommandPassed(await helper.runWp(['core', 'is-installed']), 'wp_core_is_installed');
  assertCommandPassed(await helper.runWp(['db', 'check', '--skip-ssl']), 'wp_db_check');

  const response = await dependencies.fetch(discovered.baseUrl);
  if (!response.ok) {
    throw new Error(`site_url_fetch failed with status ${response.status}: ${discovered.baseUrl}`);
  }

  const paths = resolveSitePaths(input.name, dependencies.environment);
  await mkdir(paths.dataRoot, { recursive: true });
  await access(paths.dataRoot, constants.W_OK);

  const profile = await dependencies.store.save(
    {
      schemaVersion: 1,
      name: input.name,
      composeFile: discovered.composeFile,
      projectDirectory: discovered.projectDirectory,
      projectName: discovered.projectName,
      wordpressService: discovered.wordpressService,
      baseUrl: discovered.baseUrl,
      wordpressMount: discovered.wordpressMount,
      networkName: discovered.networkName
    },
    input.force ?? false
  );

  return {
    profile,
    summary: {
      profilePath: paths.profilePath,
      artifactRoot: paths.dataRoot,
      composeProject: profile.projectName,
      wordpressService: profile.wordpressService,
      baseUrl: profile.baseUrl,
      wordpressMount: profile.wordpressMount.source,
      networkName: profile.networkName,
      helperImage: profile.helperImage
    }
  };
}

function discoveryInput(input: ConnectSiteInput): DiscoverSiteInput {
  return {
    composeFile: input.composeFile,
    ...(input.wordpressService === undefined
      ? {}
      : { wordpressService: input.wordpressService }),
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl })
  };
}

function resolveDependencies(
  dependencies: Partial<ConnectSiteDependencies> = {}
): ConnectSiteDependencies {
  const environment = dependencies.environment ?? process.env;
  return {
    discoverSite: dependencies.discoverSite ?? defaultDiscoverSite,
    createHelper:
      dependencies.createHelper ??
      ((site) => new DefaultDockerSiteHelper(site)),
    fetch:
      dependencies.fetch ??
      ((url) => {
        if (globalThis.fetch === undefined) {
          throw new Error('Fetch is not available in this Node.js runtime');
        }
        return globalThis.fetch(url);
      }),
    store: dependencies.store ?? new SiteStore(environment),
    environment
  };
}
