import { BrowserRunner } from '../browser/runner.js';
import { loadConfig, type ResolvedArgusConfig } from '../config.js';
import { MaintenanceOrchestrator } from '../orchestrator.js';
import { ProcessRunner, type ProcessRunnerLike } from '../process.js';
import { RunLock, RunStore } from '../run-store.js';
import { WordPressAdapter } from '../wordpress/adapter.js';
import { DockerWordPressAdapter } from '../wordpress/docker-adapter.js';
import { DockerSnapshotService } from '../wordpress/docker-snapshot.js';
import { SnapshotService } from '../wordpress/snapshot.js';
import { discoverSite as defaultDiscoverSite, type DiscoverSiteInput, type DiscoveredSite } from './discovery.js';
import { computeSiteFingerprint } from './fingerprint.js';
import { DockerSiteHelper } from './helper.js';
import type { SiteProfile } from './profile.js';
import { SiteStore } from './store.js';

export type ArgusRuntime = {
  config: ResolvedArgusConfig;
  store: RunStore;
  lock: RunLock;
  wordpress: WordPressAdapter | DockerWordPressAdapter;
  snapshots: SnapshotService | DockerSnapshotService;
  browser: BrowserRunner;
  orchestrator: MaintenanceOrchestrator;
};

type SiteStoreRuntime = Pick<SiteStore, 'paths' | 'load'>;

export type SiteRuntimeDependencies = {
  store?: SiteStoreRuntime;
  discoverSite?: (input: DiscoverSiteInput) => Promise<DiscoveredSite>;
  runner?: ProcessRunnerLike;
  createHelper?: (site: {
    containerId: string;
    networkName: string;
    helperImage?: string;
    wordpressEnvironment?: Record<string, string>;
  }) => unknown;
  createWordPress?: (helper: unknown) => unknown;
  createSnapshots?: (helper: unknown, store: RunStore) => unknown;
  createBrowser?: (settings: ResolvedArgusConfig, store: RunStore) => unknown;
  createOrchestrator?: (
    dependencies: {
      wordpress: unknown;
      snapshots: unknown;
      browser: unknown;
      store: RunStore;
    },
    secretValues: string[],
    options: { siteIdentity: { name: string; fingerprint: string } }
  ) => unknown;
};

export async function createConfigRuntime(configPath: string): Promise<ArgusRuntime> {
  const config = await loadConfig(configPath);
  const runner = new ProcessRunner();
  const store = new RunStore(config.artifactDir);
  const lock = new RunLock(config.artifactDir);
  const wordpress = new WordPressAdapter(runner, config.compose);
  const snapshots = new SnapshotService(runner, {
    composeFile: config.compose.file,
    wpCliService: config.compose.wpCliService,
    wordpressService: config.compose.wordpressService,
    artifactRoot: config.artifactDir,
    profiles: config.compose.profiles
  });
  const browser = new BrowserRunner(config, store);
  const orchestrator = new MaintenanceOrchestrator(
    { wordpress, snapshots, browser, store },
    config.secretValues
  );
  return { config, store, lock, wordpress, snapshots, browser, orchestrator };
}

export async function createSiteRuntime(
  name: string,
  dependencies: SiteRuntimeDependencies = {}
): Promise<ArgusRuntime> {
  const siteStore = dependencies.store ?? new SiteStore();
  const profile = await siteStore.load(name);
  const paths = siteStore.paths(name);
  const discovered = await (dependencies.discoverSite ?? defaultDiscoverSite)({
    composeFile: profile.composeFile,
    wordpressService: profile.wordpressService,
    baseUrl: profile.baseUrl
  });
  const store = new RunStore(paths.dataRoot);
  const lock = new RunLock(paths.dataRoot);
  const config = configFromProfile(profile, discovered, paths.dataRoot);
  const helperFactory =
    dependencies.createHelper ??
    ((site) => new DockerSiteHelper(site, dependencies.runner ?? new ProcessRunner()));
  const helper = helperFactory({
    containerId: discovered.containerId,
    networkName: discovered.networkName,
    helperImage: profile.helperImage,
    wordpressEnvironment: discovered.wordpressEnvironment
  });
  const wordpress = (
    dependencies.createWordPress ??
    ((helper) =>
      new DockerWordPressAdapter(
        helper as ConstructorParameters<typeof DockerWordPressAdapter>[0]
      ))
  )(helper);
  const snapshots = (
    dependencies.createSnapshots ??
    ((helper, store) =>
      new DockerSnapshotService(
        helper as ConstructorParameters<typeof DockerSnapshotService>[0],
        store
      ))
  )(helper, store);
  const browser = (dependencies.createBrowser ?? ((settings, store) => new BrowserRunner(settings, store)))(
    config,
    store
  );
  const siteIdentity = {
    name: profile.name,
    fingerprint: computeSiteFingerprint(discovered)
  };
  const orchestrator = (
    dependencies.createOrchestrator ??
    ((runtimeDependencies, secretValues, options) =>
      new MaintenanceOrchestrator(
        runtimeDependencies as ConstructorParameters<typeof MaintenanceOrchestrator>[0],
        secretValues,
        options
      ))
  )({ wordpress, snapshots, browser, store }, config.secretValues, { siteIdentity });

  return {
    config,
    store,
    lock,
    wordpress,
    snapshots,
    browser,
    orchestrator
  } as ArgusRuntime;
}

function configFromProfile(
  profile: SiteProfile,
  discovered: DiscoveredSite,
  artifactDir: string
): ResolvedArgusConfig {
  return {
    baseUrl: discovered.baseUrl,
    artifactDir,
    compose: {
      file: discovered.composeFile,
      wordpressService: discovered.wordpressService,
      wpCliService: discovered.wordpressService,
      profiles: []
    },
    visualThreshold: 0.01,
    scenarios: profile.scenarios.map((scenario) => ({
      name: scenario.name,
      path: scenario.path,
      mask: scenario.mask,
      visualThreshold: scenario.visualThreshold,
      visibleSelectors: scenario.visibleSelectors
    })),
    viewports: profile.viewports,
    secrets: {},
    secretValues: []
  };
}
