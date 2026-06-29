import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  connectSiteCommand,
  disconnectSiteCommand,
  editSiteCommand,
  listSitesCommand,
  showSiteCommand
} from '../src/sites/commands.js';
import { connectSite, type ConnectSiteDependencies, type ConnectSiteResult } from '../src/sites/connect.js';
import type { DiscoveredSite } from '../src/sites/discovery.js';
import type { SiteProfile } from '../src/sites/profile.js';
import { SiteStore } from '../src/sites/store.js';
import type { CommandRecord } from '../src/types.js';

const baseProfile: SiteProfile = {
  schemaVersion: 1,
  name: 'wp-melroseuu',
  composeFile: '/site/docker-compose.yml',
  projectDirectory: '/site',
  projectName: 'wp-melroseuu',
  wordpressService: 'wordpress',
  baseUrl: 'http://localhost:8090',
  helperImage: 'wordpress:cli',
  wordpressMount: {
    type: 'bind',
    source: '/site/wordpress',
    destination: '/var/www/html'
  },
  networkName: 'wp-melroseuu_default',
  scenarios: [
    {
      name: 'homepage',
      path: '/',
      mask: ['#wpadminbar'],
      visualThreshold: 0.01,
      visibleSelectors: ['body']
    }
  ],
  viewports: [{ name: 'desktop', width: 1440, height: 1000 }]
};

describe('site command handlers', () => {
  it('connects a site and renders the stable connection summary', async () => {
    const connectSite = vi.fn().mockResolvedValue(connectResult(baseProfile));

    const output = await connectSiteCommand(
      {
        name: 'wp-melroseuu',
        composeFile: '/site/docker-compose.yml',
        wordpressService: 'wordpress',
        baseUrl: 'http://localhost:8090',
        helperImage: 'wordpress:cli-php8.3',
        force: true
      },
      { connectSite }
    );

    expect(connectSite).toHaveBeenCalledWith({
      name: 'wp-melroseuu',
      composeFile: '/site/docker-compose.yml',
      wordpressService: 'wordpress',
      baseUrl: 'http://localhost:8090',
      helperImage: 'wordpress:cli-php8.3',
      force: true
    });
    expect(output).toBe(
      [
        'Connected site: wp-melroseuu',
        'URL: http://localhost:8090',
        'Compose project: wp-melroseuu',
        'WordPress service: wordpress',
        'Profile: /home/user/.config/argus/sites/wp-melroseuu.json',
        'Artifacts: /home/user/.local/share/argus/sites/wp-melroseuu'
      ].join('\n')
    );
  });

  it('persists helper images requested by the connect command API', async () => {
    const store = await tempStore();

    const result = await connectSite(
      {
        name: 'wp-melroseuu',
        composeFile: '/site/docker-compose.yml',
        helperImage: 'wordpress:cli-php8.3',
        force: false
      },
      connectDependencies(store)
    );

    await expect(store.load('wp-melroseuu')).resolves.toMatchObject({
      helperImage: 'wordpress:cli-php8.3'
    });
    expect(result.summary.helperImage).toBe('wordpress:cli-php8.3');
  });

  it('lists saved site names in stable order', async () => {
    const store = await tempStore();
    await store.save({ ...baseProfile, name: 'zeta' });
    await store.save({ ...baseProfile, name: 'alpha' });

    await expect(listSitesCommand({ store })).resolves.toBe('alpha\nzeta');
  });

  it('shows a saved site as validated formatted JSON', async () => {
    const store = await tempStore();
    await store.save({ ...baseProfile, helperImage: 'wordpress:cli-php8.3' });

    const output = await showSiteCommand('wp-melroseuu', { store });

    expect(JSON.parse(output)).toEqual({
      ...baseProfile,
      helperImage: 'wordpress:cli-php8.3'
    });
    expect(output).toBe(`${JSON.stringify(JSON.parse(output), null, 2)}`);
  });

  it('disconnects only the profile JSON and leaves artifacts alone', async () => {
    const store = await tempStore();
    await store.save(baseProfile);
    await writeFile(join(store.paths('wp-melroseuu').dataRoot, 'artifact.txt'), 'keep me');

    await expect(disconnectSiteCommand('wp-melroseuu', { store })).resolves.toBe(
      'Disconnected site: wp-melroseuu'
    );

    await expect(store.load('wp-melroseuu')).rejects.toThrow();
    await expect(
      readFile(join(store.paths('wp-melroseuu').dataRoot, 'artifact.txt'), 'utf8')
    ).resolves.toBe('keep me');
  });

  it('edits a copied profile with VISUAL, validates connectivity, and atomically saves on success', async () => {
    const store = await tempStore();
    await store.save(baseProfile);
    const process = fakeProcess(async (_command, _args) => {
      const tempPath = _args[3];
      if (tempPath === undefined) {
        throw new Error('missing temp path');
      }
      const edited = { ...baseProfile, baseUrl: 'http://localhost:8091' };
      await writeFile(tempPath, `${JSON.stringify(edited, null, 2)}\n`);
      return commandRecord(_command, _args);
    });
    const validateConnectivity = vi.fn().mockResolvedValue(undefined);

    const output = await editSiteCommand('wp-melroseuu', {
      store,
      process,
      environment: { VISUAL: 'nano', EDITOR: 'vim' },
      validateConnectivity
    });

    expect(process.run).toHaveBeenCalledWith('/bin/sh', [
      '-c',
      'exec "$0" "$1"',
      'nano',
      expect.stringContaining('wp-melroseuu')
    ]);
    expect(validateConnectivity).toHaveBeenCalledWith({
      ...baseProfile,
      baseUrl: 'http://localhost:8091'
    });
    await expect(store.load('wp-melroseuu')).resolves.toMatchObject({
      baseUrl: 'http://localhost:8091'
    });
    expect(output).toBe('Updated site: wp-melroseuu');
  });

  it('falls back to EDITOR for edit and rejects empty editor environment values', async () => {
    const store = await tempStore();
    await store.save(baseProfile);
    const process = fakeProcess(async (command, args) => commandRecord(command, args));

    await expect(
      editSiteCommand('wp-melroseuu', {
        store,
        process,
        environment: { VISUAL: '', EDITOR: 'vim' },
        validateConnectivity: vi.fn().mockResolvedValue(undefined)
      })
    ).resolves.toBe('Updated site: wp-melroseuu');
    expect(process.run).toHaveBeenCalledWith('/bin/sh', [
      '-c',
      'exec "$0" "$1"',
      'vim',
      expect.any(String)
    ]);

    await expect(
      editSiteCommand('wp-melroseuu', {
        store,
        process,
        environment: { VISUAL: '', EDITOR: '   ' },
        validateConnectivity: vi.fn().mockResolvedValue(undefined)
      })
    ).rejects.toThrow('Set VISUAL or EDITOR to edit site profiles');
  });

  it('preserves the original profile when edited JSON fails schema validation', async () => {
    const store = await tempStore();
    await store.save(baseProfile);
    const process = fakeProcess(async (command, args) => {
      const tempPath = args[3];
      if (tempPath === undefined) {
        throw new Error('missing temp path');
      }
      await writeFile(tempPath, '{"schemaVersion":1,"name":"wp-melroseuu"}\n');
      return commandRecord(command, args);
    });
    const validateConnectivity = vi.fn().mockResolvedValue(undefined);

    await expect(
      editSiteCommand('wp-melroseuu', {
        store,
        process,
        environment: { EDITOR: 'vim' },
        validateConnectivity
      })
    ).rejects.toThrow();

    expect(validateConnectivity).not.toHaveBeenCalled();
    await expect(store.load('wp-melroseuu')).resolves.toEqual(baseProfile);
  });

  it('preserves the original profile when live validation fails after editing', async () => {
    const store = await tempStore();
    await store.save(baseProfile);
    const process = fakeProcess(async (command, args) => {
      const tempPath = args[3];
      if (tempPath === undefined) {
        throw new Error('missing temp path');
      }
      await writeFile(
        tempPath,
        `${JSON.stringify({ ...baseProfile, baseUrl: 'http://localhost:8099' }, null, 2)}\n`
      );
      return commandRecord(command, args);
    });

    await expect(
      editSiteCommand('wp-melroseuu', {
        store,
        process,
        environment: { EDITOR: 'vim' },
        validateConnectivity: vi.fn().mockRejectedValue(new Error('site_url_fetch failed'))
      })
    ).rejects.toThrow('site_url_fetch failed');

    await expect(store.load('wp-melroseuu')).resolves.toEqual(baseProfile);
  });
});

function connectResult(profile: SiteProfile): ConnectSiteResult {
  return {
    profile,
    summary: {
      profilePath: `/home/user/.config/argus/sites/${profile.name}.json`,
      artifactRoot: `/home/user/.local/share/argus/sites/${profile.name}`,
      composeProject: profile.projectName,
      wordpressService: profile.wordpressService,
      baseUrl: profile.baseUrl,
      wordpressMount: profile.wordpressMount.source,
      networkName: profile.networkName,
      helperImage: profile.helperImage
    }
  };
}

async function tempStore(): Promise<SiteStore> {
  const home = await mkdtemp(join(tmpdir(), 'argus-site-commands-'));
  return new SiteStore({ HOME: home });
}

function fakeProcess(
  run: (command: string, args: string[]) => Promise<CommandRecord>
): { run: ReturnType<typeof vi.fn<(command: string, args: string[]) => Promise<CommandRecord>>> } {
  return {
    run: vi.fn(run)
  };
}

function commandRecord(command: string, args: string[]): CommandRecord {
  return {
    command,
    args,
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 1
  };
}

function connectDependencies(store: SiteStore): ConnectSiteDependencies {
  return {
    discoverSite: vi.fn().mockResolvedValue(discoveredSite()),
    createHelper: vi.fn().mockReturnValue({
      runWp: vi.fn().mockResolvedValue(commandRecord('wp', []))
    }),
    fetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    store
  };
}

function discoveredSite(): DiscoveredSite {
  return {
    composeFile: baseProfile.composeFile,
    projectDirectory: baseProfile.projectDirectory,
    projectName: baseProfile.projectName,
    wordpressService: baseProfile.wordpressService,
    containerId: 'container-id',
    baseUrl: baseProfile.baseUrl,
    networkName: baseProfile.networkName,
    wordpressMount: baseProfile.wordpressMount,
    wordpressEnvironment: {
      WORDPRESS_DB_HOST: 'db',
      WORDPRESS_DB_NAME: 'wordpress',
      WORDPRESS_DB_USER: 'wordpress',
      WORDPRESS_DB_PASSWORD: 'secret'
    }
  };
}
