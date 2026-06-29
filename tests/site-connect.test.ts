import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { connectSite, type ConnectSiteDependencies } from '../src/sites/connect.js';
import type { DiscoveredSite } from '../src/sites/discovery.js';
import type { DockerSiteHelper } from '../src/sites/helper.js';
import { resolveSitePaths } from '../src/sites/paths.js';
import type { SiteProfile } from '../src/sites/profile.js';
import { SiteStore } from '../src/sites/store.js';
import type { CommandRecord } from '../src/types.js';

const discoveredSite: DiscoveredSite = {
  composeFile: '/site/docker-compose.yml',
  projectDirectory: '/site',
  projectName: 'site',
  wordpressService: 'wordpress',
  containerId: 'runtime-container-id',
  baseUrl: 'http://localhost:8090',
  networkName: 'site_default',
  wordpressMount: {
    type: 'bind',
    source: '/site/wordpress',
    destination: '/var/www/html'
  },
  wordpressEnvironment: {
    WORDPRESS_DB_HOST: 'db:3306',
    WORDPRESS_DB_NAME: 'wordpress',
    WORDPRESS_DB_USER: 'wordpress',
    WORDPRESS_DB_PASSWORD: 'secret'
  }
};

function commandResult(args: string[] = []): CommandRecord {
  return {
    command: 'docker',
    args,
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 1
  };
}

describe('connectSite', () => {
  it('validates a discovered site, saves a default v1 profile, and returns a printable summary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-site-connect-'));
    const store = new SiteStore({ HOME: home });
    const helper = fakeHelper();
    const fetch = vi.fn<ConnectSiteDependencies['fetch']>().mockResolvedValue({
      ok: true,
      status: 200
    });
    const discoverSite = vi.fn<ConnectSiteDependencies['discoverSite']>().mockResolvedValue(discoveredSite);
    const createHelper = vi.fn<ConnectSiteDependencies['createHelper']>().mockReturnValue(helper);
    const dependencies: ConnectSiteDependencies = {
      discoverSite,
      createHelper,
      fetch,
      store
    };

    const result = await connectSite(
      {
        name: 'wp-melroseuu',
        composeFile: '/site/docker-compose.yml',
        wordpressService: undefined,
        baseUrl: undefined,
        force: false
      },
      dependencies
    );

    expect(discoverSite).toHaveBeenCalledWith({
      composeFile: '/site/docker-compose.yml'
    });
    expect(createHelper).toHaveBeenCalledWith({
      containerId: 'runtime-container-id',
      networkName: 'site_default',
      wordpressEnvironment: discoveredSite.wordpressEnvironment
    });
    expect(helper.runWp).toHaveBeenNthCalledWith(1, ['core', 'is-installed']);
    expect(helper.runWp).toHaveBeenNthCalledWith(2, ['db', 'check', '--skip-ssl']);
    expect(fetch).toHaveBeenCalledWith('http://localhost:8090');

    const saved = await store.load('wp-melroseuu');
    expect(saved).toMatchObject({
      schemaVersion: 1,
      name: 'wp-melroseuu',
      composeFile: '/site/docker-compose.yml',
      projectDirectory: '/site',
      projectName: 'site',
      wordpressService: 'wordpress',
      baseUrl: 'http://localhost:8090',
      helperImage: 'wordpress:cli',
      wordpressMount: discoveredSite.wordpressMount,
      networkName: 'site_default'
    });
    expect(JSON.stringify(saved)).not.toContain('runtime-container-id');
    expect(JSON.stringify(saved)).not.toContain('WORDPRESS_DB_PASSWORD');

    const paths = resolveSitePaths('wp-melroseuu', { HOME: home });
    expect(result).toEqual({
      profile: saved,
      summary: {
        profilePath: paths.profilePath,
        artifactRoot: paths.dataRoot,
        composeProject: 'site',
        wordpressService: 'wordpress',
        baseUrl: 'http://localhost:8090',
        wordpressMount: '/site/wordpress',
        networkName: 'site_default',
        helperImage: 'wordpress:cli'
      }
    });
  });

  it('does not save when any validation check fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-site-connect-'));
    const store = new SiteStore({ HOME: home });
    const helper = fakeHelper();
    helper.runWp.mockResolvedValueOnce(commandResult(['wp', 'core', 'is-installed']));
    helper.runWp.mockResolvedValueOnce({
      ...commandResult(['wp', 'db', 'check', '--skip-ssl']),
      exitCode: 1,
      stderr: 'database error'
    });

    await expect(
      connectSite(
        { name: 'wp-melroseuu', composeFile: '/site/docker-compose.yml', force: false },
        {
          discoverSite: vi.fn().mockResolvedValue(discoveredSite),
          createHelper: vi.fn().mockReturnValue(helper),
          fetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
          store
        }
      )
    ).rejects.toThrow(/wp_db_check failed with exit code 1: database error/);
    await expect(store.load('wp-melroseuu')).rejects.toThrow();
  });

  it('honors force when overwriting an existing profile', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-site-connect-'));
    const store = new SiteStore({ HOME: home });
    await seedProfile(store, { baseUrl: 'http://localhost:8080' });
    const fetch = vi.fn<ConnectSiteDependencies['fetch']>().mockResolvedValue({
      ok: true,
      status: 200
    });

    await expect(
      connectSite(
        { name: 'wp-melroseuu', composeFile: '/site/docker-compose.yml', force: false },
        dependenciesFor({ store, fetch })
      )
    ).rejects.toThrow(/already exists/i);

    await expect(
      connectSite(
        { name: 'wp-melroseuu', composeFile: '/site/docker-compose.yml', force: true },
        dependenciesFor({ store, fetch })
      )
    ).resolves.toMatchObject({
      profile: { baseUrl: 'http://localhost:8090' }
    });
    await expect(store.load('wp-melroseuu')).resolves.toMatchObject({
      baseUrl: 'http://localhost:8090'
    });
  });

  it('uses the injected store as the single source for profile and artifact paths', async () => {
    const storeHome = await mkdtemp(join(tmpdir(), 'argus-site-connect-store-'));
    const mismatchedHome = await mkdtemp(join(tmpdir(), 'argus-site-connect-other-'));
    const store = new SiteStore({ HOME: storeHome });
    const storePaths = resolveSitePaths('wp-melroseuu', { HOME: storeHome });
    const mismatchedPaths = resolveSitePaths('wp-melroseuu', { HOME: mismatchedHome });
    const dependenciesWithIgnoredEnvironment = {
      ...dependenciesFor({ store }),
      environment: { HOME: mismatchedHome }
    };

    const result = await connectSite(
      { name: 'wp-melroseuu', composeFile: '/site/docker-compose.yml', force: false },
      dependenciesWithIgnoredEnvironment
    );

    expect(result.summary.profilePath).toBe(storePaths.profilePath);
    expect(result.summary.artifactRoot).toBe(storePaths.dataRoot);
    await expect(store.load('wp-melroseuu')).resolves.toMatchObject({
      baseUrl: 'http://localhost:8090'
    });
    await expect(access(storePaths.dataRoot)).resolves.toBeUndefined();
    await expect(access(mismatchedPaths.dataRoot)).rejects.toThrow();
  });
});

function fakeHelper(): Pick<DockerSiteHelper, 'runWp'> & {
  runWp: ReturnType<typeof vi.fn<DockerSiteHelper['runWp']>>;
} {
  return {
    runWp: vi.fn<DockerSiteHelper['runWp']>().mockResolvedValue(commandResult())
  };
}

function dependenciesFor(
  overrides: Partial<ConnectSiteDependencies> = {}
): ConnectSiteDependencies {
  return {
    discoverSite: vi.fn().mockResolvedValue(discoveredSite),
    createHelper: vi.fn().mockReturnValue(fakeHelper()),
    fetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    store: new SiteStore(),
    ...overrides
  };
}

async function seedProfile(
  store: SiteStore,
  overrides: Partial<SiteProfile> = {}
): Promise<void> {
  await store.save({
    schemaVersion: 1,
    name: 'wp-melroseuu',
    composeFile: '/site/docker-compose.yml',
    projectDirectory: '/site',
    projectName: 'site',
    wordpressService: 'wordpress',
    baseUrl: 'http://localhost:8090',
    wordpressMount: discoveredSite.wordpressMount,
    networkName: 'site_default',
    ...overrides
  });
}
