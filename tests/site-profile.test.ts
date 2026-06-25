import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSitePaths } from '../src/sites/paths.js';
import { siteProfileSchema } from '../src/sites/profile.js';
import { SiteStore } from '../src/sites/store.js';

const profileInput = {
  schemaVersion: 1 as const,
  name: 'melrose',
  composeFile: '/sites/melrose/docker-compose.yml',
  projectDirectory: '/sites/melrose',
  projectName: 'melrose',
  wordpressService: 'wordpress',
  baseUrl: 'http://localhost:8090',
  wordpressMount: {
    type: 'volume' as const,
    source: 'melrose_wordpress',
    destination: '/var/www/html' as const
  },
  networkName: 'melrose_default'
};

describe('resolveSitePaths', () => {
  it('uses XDG config and data roots when provided', () => {
    expect(
      resolveSitePaths('melrose', {
        XDG_CONFIG_HOME: '/tmp/config',
        XDG_DATA_HOME: '/tmp/data',
        HOME: '/home/test'
      })
    ).toEqual({
      profilePath: '/tmp/config/argus/sites/melrose.json',
      dataRoot: '/tmp/data/argus/sites/melrose'
    });
  });

  it('falls back to HOME config and data roots', () => {
    expect(resolveSitePaths('melrose', { HOME: '/home/test' })).toEqual({
      profilePath: '/home/test/.config/argus/sites/melrose.json',
      dataRoot: '/home/test/.local/share/argus/sites/melrose'
    });
  });

  it('ignores relative XDG roots and falls back to HOME', () => {
    expect(
      resolveSitePaths('melrose', {
        XDG_CONFIG_HOME: 'relative-config',
        XDG_DATA_HOME: 'relative-data',
        HOME: '/home/test'
      })
    ).toEqual({
      profilePath: '/home/test/.config/argus/sites/melrose.json',
      dataRoot: '/home/test/.local/share/argus/sites/melrose'
    });
  });

  it('rejects environments without absolute config and data roots', () => {
    expect(() =>
      resolveSitePaths('melrose', {
        XDG_CONFIG_HOME: 'relative-config',
        XDG_DATA_HOME: 'relative-data',
        HOME: 'relative-home'
      })
    ).toThrow(/absolute.*config.*data/i);
  });

  it.each(['../escape', 'nested/site', '/absolute', 'Uppercase', '-leading'])(
    'rejects invalid site name %s',
    (name) => {
      expect(() => resolveSitePaths(name, { HOME: '/home/test' })).toThrow(/site name/i);
    }
  );
});

describe('siteProfileSchema', () => {
  it('applies safe declarative scenario and viewport defaults', () => {
    expect(siteProfileSchema.parse(profileInput)).toEqual({
      ...profileInput,
      helperImage: 'wordpress:cli',
      scenarios: [
        {
          name: 'homepage',
          path: '/',
          mask: ['#wpadminbar'],
          visualThreshold: 0.01,
          visibleSelectors: ['body']
        }
      ],
      viewports: [
        { name: 'desktop', width: 1440, height: 1000 },
        { name: 'mobile', width: 390, height: 844 }
      ]
    });
  });

  it('accepts declarative scenario fields and rejects invalid paths or thresholds', () => {
    const parsed = siteProfileSchema.parse({
      ...profileInput,
      scenarios: [
        {
          name: 'about',
          path: '/about',
          mask: ['.dynamic'],
          visualThreshold: 0.25,
          visibleSelectors: ['main', 'h1']
        }
      ]
    });

    expect(parsed.scenarios[0]).toEqual({
      name: 'about',
      path: '/about',
      mask: ['.dynamic'],
      visualThreshold: 0.25,
      visibleSelectors: ['main', 'h1']
    });
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        scenarios: [{ name: 'bad', path: 'relative' }]
      })
    ).toThrow();
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        scenarios: [{ name: 'bad', path: '/', visualThreshold: 1.01 }]
      })
    ).toThrow();
  });

  it.each(['//example.com', '/\\example.com'])(
    'rejects non-relative scenario path %s',
    (path) => {
      expect(() =>
        siteProfileSchema.parse({
          ...profileInput,
          scenarios: [{ name: 'external', path }]
        })
      ).toThrow();
    }
  );

  it('rejects credentials and unknown fields at every profile level', () => {
    expect(() =>
      siteProfileSchema.parse({ ...profileInput, credentials: { password: 'secret' } })
    ).toThrow();
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        wordpressMount: { ...profileInput.wordpressMount, password: 'secret' }
      })
    ).toThrow();
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        scenarios: [{ name: 'home', path: '/', run: 'arbitrary-code' }]
      })
    ).toThrow();
  });

  it('rejects invalid names and mount destinations', () => {
    expect(() => siteProfileSchema.parse({ ...profileInput, name: '../escape' })).toThrow();
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        wordpressMount: { ...profileInput.wordpressMount, destination: '/tmp/wordpress' }
      })
    ).toThrow();
  });

  it('rejects duplicate scenario names', () => {
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        scenarios: [
          { name: 'homepage', path: '/' },
          { name: 'homepage', path: '/again' }
        ]
      })
    ).toThrow(/duplicate scenario name/i);
  });

  it('rejects duplicate viewport names', () => {
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        viewports: [
          { name: 'desktop', width: 1440, height: 1000 },
          { name: 'desktop', width: 1024, height: 768 }
        ]
      })
    ).toThrow(/duplicate viewport name/i);
  });

  it('rejects scenario names that collide after BrowserRunner normalization', () => {
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        scenarios: [
          { name: 'Home Page', path: '/' },
          { name: 'home-page', path: '/again' }
        ]
      })
    ).toThrow();
  });

  it('rejects viewport names that collide after BrowserRunner normalization', () => {
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        viewports: [
          { name: 'Wide Screen', width: 1440, height: 1000 },
          { name: 'wide-screen', width: 1024, height: 768 }
        ]
      })
    ).toThrow();
  });

  it('rejects repeated-hyphen scenario keys that normalize to the same artifact key', () => {
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        scenarios: [
          { name: 'home--page', path: '/' },
          { name: 'home-page', path: '/again' }
        ]
      })
    ).toThrow();
  });

  it('rejects trailing-hyphen viewport keys that normalize to the same artifact key', () => {
    expect(() =>
      siteProfileSchema.parse({
        ...profileInput,
        viewports: [
          { name: 'wide-', width: 1440, height: 1000 },
          { name: 'wide', width: 1024, height: 768 }
        ]
      })
    ).toThrow();
  });
});

describe('SiteStore', () => {
  it('atomically saves and loads a validated profile', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-site-store-'));
    const store = new SiteStore({ HOME: home });
    const saved = await store.save(profileInput);
    const paths = resolveSitePaths('melrose', { HOME: home });

    await expect(readFile(paths.profilePath, 'utf8').then(JSON.parse)).resolves.toEqual(saved);
    await expect(store.load('melrose')).resolves.toEqual(saved);
    await expect(access(`${paths.profilePath}.tmp`)).rejects.toThrow();
    await expect(access(paths.dataRoot)).resolves.toBeUndefined();
  });

  it('protects existing profiles unless force is enabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-site-store-'));
    const store = new SiteStore({ HOME: home });
    await store.save(profileInput);
    const profileDirectory = join(home, '.config', 'argus', 'sites');

    await expect(
      store.save({ ...profileInput, baseUrl: 'http://localhost:8091' })
    ).rejects.toThrow(/already exists/i);
    await expect(readdir(profileDirectory)).resolves.toEqual(['melrose.json']);

    await expect(
      store.save({ ...profileInput, baseUrl: 'http://localhost:8091' }, true)
    ).resolves.toMatchObject({ baseUrl: 'http://localhost:8091' });
    await expect(store.load('melrose')).resolves.toMatchObject({
      baseUrl: 'http://localhost:8091'
    });
    await expect(readdir(profileDirectory)).resolves.toEqual(['melrose.json']);
  });

  it('allows exactly one concurrent non-force save and cleans unique temp files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-site-store-'));
    const store = new SiteStore({ HOME: home });
    const firstProfile = { ...profileInput, baseUrl: 'http://localhost:8091' };
    const secondProfile = { ...profileInput, baseUrl: 'http://localhost:8092' };

    const results = await Promise.allSettled([
      store.save(firstProfile),
      store.save(secondProfile)
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<SiteStore['save']>>> =>
        result.status === 'fulfilled'
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(Error);
    expect((rejected[0]?.reason as Error).message).toMatch(/already exists/i);

    const saved = await store.load('melrose');
    expect(saved).toEqual(fulfilled[0]?.value);
    expect([firstProfile.baseUrl, secondProfile.baseUrl]).toContain(saved.baseUrl);
    await expect(readdir(join(home, '.config', 'argus', 'sites'))).resolves.toEqual([
      'melrose.json'
    ]);
  });

  it('validates profiles when saving and loading', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-site-store-'));
    const store = new SiteStore({ HOME: home });

    await expect(
      store.save({ ...profileInput, credentials: { password: 'secret' } })
    ).rejects.toThrow();

    const paths = resolveSitePaths('melrose', { HOME: home });
    await mkdir(join(home, '.config', 'argus', 'sites'), { recursive: true });
    await writeFile(
      paths.profilePath,
      JSON.stringify({ ...profileInput, credentials: { password: 'secret' } })
    );

    await expect(store.load('melrose')).rejects.toThrow();
  });

  it('lists profile names in sorted order and ignores unrelated files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-site-store-'));
    const store = new SiteStore({ HOME: home });
    await store.save({ ...profileInput, name: 'zulu' });
    await store.save({ ...profileInput, name: 'alpha' });
    await writeFile(join(home, '.config', 'argus', 'sites', 'notes.txt'), 'ignore');

    await expect(store.list()).resolves.toEqual(['alpha', 'zulu']);
  });

  it('disconnects only the profile and preserves site data', async () => {
    const home = await mkdtemp(join(tmpdir(), 'argus-site-store-'));
    const store = new SiteStore({ HOME: home });
    await store.save(profileInput);
    const paths = resolveSitePaths('melrose', { HOME: home });
    await writeFile(join(paths.dataRoot, 'artifact.txt'), 'keep');

    await store.disconnect('melrose');

    await expect(access(paths.profilePath)).rejects.toThrow();
    await expect(readFile(join(paths.dataRoot, 'artifact.txt'), 'utf8')).resolves.toBe('keep');
    await expect(store.list()).resolves.toEqual([]);
  });
});
