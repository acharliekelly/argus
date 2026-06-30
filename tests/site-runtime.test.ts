import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunLock, RunStore } from '../src/run-store.js';
import { computeSiteFingerprint } from '../src/sites/fingerprint.js';
import { createSiteRuntime } from '../src/sites/runtime.js';
import type { DiscoveredSite } from '../src/sites/discovery.js';
import type { SiteProfile } from '../src/sites/profile.js';

const discoveredSite: DiscoveredSite = {
  composeFile: '/site/docker-compose.yml',
  projectDirectory: '/site',
  projectName: 'melrose',
  wordpressService: 'wordpress',
  containerId: 'new-container-id',
  baseUrl: 'http://localhost:8090',
  networkName: 'melrose_default',
  wordpressMount: {
    type: 'bind',
    source: '/site/wordpress',
    destination: '/var/www/html'
  },
  wordpressEnvironment: {
    WORDPRESS_DB_HOST: 'db:3306',
    WORDPRESS_DB_NAME: 'wordpress',
    WORDPRESS_DB_USER: 'wordpress',
    WORDPRESS_DB_PASSWORD: 'secret',
    WORDPRESS_TABLE_PREFIX: '3Ge_'
  }
};

const profile: SiteProfile = {
  schemaVersion: 1,
  name: 'wp-melroseuu',
  composeFile: '/site/docker-compose.yml',
  projectDirectory: '/site',
  projectName: 'melrose',
  wordpressService: 'wordpress',
  baseUrl: 'http://localhost:8090',
  helperImage: 'wordpress:cli',
  wordpressMount: discoveredSite.wordpressMount,
  networkName: 'melrose_default',
  scenarios: [
    {
      name: 'homepage',
      path: '/',
      visibleSelectors: ['main', 'h1'],
      mask: ['#wpadminbar'],
      visualThreshold: 0.02
    }
  ],
  viewports: [{ name: 'desktop', width: 1440, height: 1000 }]
};

describe('site runtime', () => {
  it('loads a saved site profile and builds a runtime around the current live target', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-site-runtime-'));
    const store = {
      paths: vi.fn().mockReturnValue({
        profilePath: join(home, '.config/argus/sites/wp-melroseuu.json'),
        dataRoot: join(home, '.local/share/argus/sites/wp-melroseuu')
      }),
      load: vi.fn().mockResolvedValue(profile)
    };
    const discoverSite = vi.fn().mockResolvedValue(discoveredSite);
    const createHelper = vi.fn((site) => ({ kind: 'helper', site }));
    const createWordPress = vi.fn((helper) => ({ kind: 'wordpress', helper }));
    const createSnapshots = vi.fn((helper, runStore) => ({ kind: 'snapshots', helper, runStore }));
    const createBrowser = vi.fn((settings, runStore) => ({ kind: 'browser', settings, runStore }));
    const createOrchestrator = vi.fn((dependencies, secrets, options) => ({
      kind: 'orchestrator',
      dependencies,
      secrets,
      options
    }));

    const runtime = await createSiteRuntime('wp-melroseuu', {
      store,
      discoverSite,
      createHelper,
      createWordPress,
      createSnapshots,
      createBrowser,
      createOrchestrator
    });

    expect(store.load).toHaveBeenCalledWith('wp-melroseuu');
    expect(store.paths).toHaveBeenCalledWith('wp-melroseuu');
    expect(discoverSite).toHaveBeenCalledWith({
      composeFile: '/site/docker-compose.yml',
      wordpressService: 'wordpress',
      baseUrl: 'http://localhost:8090'
    });
    expect(createHelper).toHaveBeenCalledWith({
      containerId: 'new-container-id',
      networkName: 'melrose_default',
      helperImage: 'wordpress:cli',
      wordpressEnvironment: {
        ...discoveredSite.wordpressEnvironment,
        HTTP_HOST: 'localhost:8090'
      }
    });
    expect(runtime.store).toBeInstanceOf(RunStore);
    expect(runtime.lock).toBeInstanceOf(RunLock);
    expect(runtime.store.root).toBe(join(home, '.local/share/argus/sites/wp-melroseuu'));
    expect(runtime.lock.lockPath).toBe(
      join(home, '.local/share/argus/sites/wp-melroseuu/lock.json')
    );
    expect(createBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://localhost:8090',
        visualThreshold: 0.01,
        secrets: {},
        scenarios: [
          {
            name: 'homepage',
            path: '/',
            visibleSelectors: ['main', 'h1'],
            mask: ['#wpadminbar'],
            visualThreshold: 0.02
          }
        ],
        viewports: [{ name: 'desktop', width: 1440, height: 1000 }]
      }),
      runtime.store
    );
    const browserSettings = createBrowser.mock.calls[0]?.[0] as {
      scenarios: Array<{ run?: unknown }>;
    };
    expect(browserSettings.scenarios[0]?.run).toBeUndefined();
    expect(createOrchestrator).toHaveBeenCalledWith(
      {
        wordpress: runtime.wordpress,
        snapshots: runtime.snapshots,
        browser: runtime.browser,
        store: runtime.store
      },
      [],
      {
        siteIdentity: {
          name: 'wp-melroseuu',
          fingerprint: computeSiteFingerprint(discoveredSite)
        }
      }
    );
    expect(runtime.config.artifactDir).toBe(join(home, '.local/share/argus/sites/wp-melroseuu'));
  });

  it('accepts a recreated container when the discovered site fingerprint is stable', async () => {
    const current = {
      ...discoveredSite,
      containerId: 'container-after-recreate'
    };
    const store = {
      paths: vi.fn().mockReturnValue({
        profilePath: '/home/user/.config/argus/sites/wp-melroseuu.json',
        dataRoot: '/home/user/.local/share/argus/sites/wp-melroseuu'
      }),
      load: vi.fn().mockResolvedValue(profile)
    };

    const runtime = await createSiteRuntime('wp-melroseuu', {
      store,
      discoverSite: vi.fn().mockResolvedValue(current),
      createHelper: vi.fn((site) => ({ site })),
      createWordPress: vi.fn(() => ({})),
      createSnapshots: vi.fn(() => ({})),
      createBrowser: vi.fn(() => ({})),
      createOrchestrator: vi.fn((dependencies, secrets, options) => ({ dependencies, secrets, options }))
    });

    expect(
      (
        runtime.orchestrator as unknown as {
          options: { siteIdentity: { name: string; fingerprint: string } };
        }
      ).options.siteIdentity
    ).toEqual({
      name: 'wp-melroseuu',
      fingerprint: computeSiteFingerprint(discoveredSite)
    });
  });
});
