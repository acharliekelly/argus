import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa, type Options } from 'execa';
import { describe, expect, it } from 'vitest';

const integration = process.env.ARGUS_DOCKER_INTEGRATION === '1' ? describe : describe.skip;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureSource = join(repositoryRoot, 'tests/fixtures/named-site');

type CommandEnvironment = NodeJS.ProcessEnv & {
  ARGUS_NAMED_SITE_PORT: string;
  COMPOSE_PROJECT_NAME: string;
  HOME: string;
  PLAYWRIGHT_BROWSERS_PATH: string;
  XDG_CONFIG_HOME: string;
  XDG_DATA_HOME: string;
};

integration('named-site Docker workflow', () => {
  it('connects by name and Compose path, updates, rolls back, survives container recreation, and preserves artifacts', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'argus-named-site-'));
    const fixtureRoot = join(testRoot, 'fixture');
    const home = join(testRoot, 'home');
    const playwrightBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME ?? home, '.cache/ms-playwright');
    const port = await reservePort();
    const siteName = `named-${randomUUID().slice(0, 8)}`;
    const projectName = `argus_named_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const environment: CommandEnvironment = {
      ...process.env,
      ARGUS_NAMED_SITE_PORT: String(port),
      COMPOSE_PROJECT_NAME: projectName,
      HOME: home,
      PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
      XDG_CONFIG_HOME: join(testRoot, 'xdg-config'),
      XDG_DATA_HOME: join(testRoot, 'xdg-data')
    };
    let composeStarted = false;

    try {
      await cp(fixtureSource, fixtureRoot, { recursive: true });
      await mkdir(join(fixtureRoot, 'wordpress/wp-content/upgrade'), { recursive: true });
      await mkdir(join(fixtureRoot, 'wordpress/wp-content/upgrade-temp-backup'), { recursive: true });
      await execa('chmod', ['-R', 'a+rwX', join(fixtureRoot, 'wordpress/wp-content')]);
      const composeFile = join(fixtureRoot, 'docker-compose.yml');
      await createPluginUpdateZip(fixtureRoot);
      const composeHashBefore = await sha256File(composeFile);
      const gitStatusBefore = await gitStatus();

      await dockerCompose(environment, composeFile, ['up', '-d', 'db', 'wordpress', 'update-server']);
      composeStarted = true;
      await waitForHttp(`http://127.0.0.1:${port}/`);
      await dockerCompose(environment, composeFile, [
        'exec',
        '-T',
        '--user',
        'root',
        'wordpress',
        'chmod',
        '-R',
        'a+rwX',
        '/var/www/html/wp-content'
      ]);
      await dockerCompose(environment, composeFile, [
        'run',
        '--rm',
        'wpcli',
        'wp',
        'core',
        'install',
        `--url=http://127.0.0.1:${port}`,
        '--title=Argus Named Site',
        '--admin_user=admin',
        '--admin_password=password',
        '--admin_email=admin@example.test',
        '--skip-email',
        '--allow-root'
      ]);
      await dockerCompose(environment, composeFile, [
        'run',
        '--rm',
        'wpcli',
        'wp',
        'plugin',
        'activate',
        'argus-regression',
        '--allow-root'
      ]);

      await argus(environment, [
        'connect',
        siteName,
        '--compose',
        composeFile
      ]);

      const inventoryBefore = JSON.parse(
        String((await argus(environment, ['--site', siteName, 'inventory'])).stdout)
      ) as Inventory;
      expect(pluginVersion(inventoryBefore, 'argus-regression')).toBe('1.0.0');
      expect(pluginUpdateVersion(inventoryBefore, 'argus-regression')).toBe('2.0.0');

      await argus(environment, ['--site', siteName, 'check']);

      const update = await argus(environment, [
        '--site',
        siteName,
        'update',
        '--type',
        'plugin',
        '--slug',
        'argus-regression'
      ], { reject: false });
      expect(update.exitCode).toBe(1);
      const updateOutput = String(update.stdout);
      expect(updateOutput).toContain('Status: failed');

      const runId = extractRunId(updateOutput);
      const artifactRoot = join(environment.XDG_DATA_HOME, 'argus/sites', siteName);
      const reportPath = join(artifactRoot, 'runs', runId, 'report.json');
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as Report;
      if (report.reasonCodes.includes('update_failed')) {
        throw new Error(`Fixture update failed: ${JSON.stringify(report.commands, null, 2)}`);
      }
      expect(updateOutput).toContain('Recommendation: rollback');
      expect(report.schemaVersion).toBe(2);
      expect(report.site).toMatchObject({ name: siteName });
      expect(report.site?.fingerprint).toMatch(/^sha256:/);
      expect(report.inventory.before?.plugins.find(({ slug }) => slug === 'argus-regression')?.version).toBe(
        '1.0.0'
      );
      expect(report.inventory.after?.plugins.find(({ slug }) => slug === 'argus-regression')?.version).toBe(
        '2.0.0'
      );
      expect(report.checks.baseline[0]?.screenshotPath).toMatch(/^screenshots\/baseline\/.+\.png$/);
      expect(report.checks.after[0]?.screenshotPath).toMatch(/^screenshots\/after\/.+\.png$/);
      expect(report.checks.visual[0]?.diffPath).toMatch(/^screenshots\/diff\/.+\.png$/);
      await expect(readFile(join(artifactRoot, 'runs', runId, report.checks.visual[0]!.diffPath!))).resolves.toBeInstanceOf(Buffer);
      const contentSnapshot = await readFile(join(artifactRoot, 'runs', runId, report.snapshot!.contentPath));
      expect([...contentSnapshot.subarray(0, 2)]).toEqual([0x1f, 0x8b]);

      const rollback = await argus(environment, ['--site', siteName, 'rollback', '--run', runId]);
      expect(rollback.stdout).toContain('Status: rolled_back');

      const inventoryAfterRollback = JSON.parse(
        String((await argus(environment, ['--site', siteName, 'inventory'])).stdout)
      ) as Inventory;
      expect(pluginVersion(inventoryAfterRollback, 'argus-regression')).toBe('1.0.0');

      await dockerCompose(environment, composeFile, ['up', '-d', '--force-recreate', 'wordpress']);
      await waitForHttp(`http://127.0.0.1:${port}/`);
      const inventoryAfterRecreate = JSON.parse(
        String((await argus(environment, ['--site', siteName, 'inventory'])).stdout)
      ) as Inventory;
      expect(pluginVersion(inventoryAfterRecreate, 'argus-regression')).toBe('1.0.0');

      await argus(environment, ['site', 'disconnect', siteName]);
      await expect(readFile(join(environment.XDG_CONFIG_HOME, 'argus/sites', `${siteName}.json`))).rejects.toThrow();
      await expect(readdir(join(artifactRoot, 'runs'))).resolves.toContain(runId);

      expect(await sha256File(composeFile)).toBe(composeHashBefore);
      expect(await gitStatus()).toBe(gitStatusBefore);
    } finally {
      if (composeStarted) {
        await dockerCompose(environment, join(fixtureRoot, 'docker-compose.yml'), [
          'down',
          '-v',
          '--remove-orphans'
        ], { reject: false });
      }
      await removeDisposableTree(testRoot);
    }
  }, 300_000);

  integration.skip('TODO: run the same workflow against a named-volume WordPress mount', () => {
    /*
     * The bind-mounted fixture exercises the full named-site path without mutating this repository.
     * A named-volume variant needs a separate seeding path for the regression plugin and update zip
     * inside the Docker volume; that is useful coverage, but too heavy to add without extending the
     * fixture setup contract beyond this task.
     */
  });
});

async function argus(
  env: CommandEnvironment,
  args: string[],
  options: Options = {}
) {
  return execa('npm', ['--silent', 'run', 'argus', '--', ...args], {
    cwd: repositoryRoot,
    env,
    reject: true,
    ...options
  });
}

async function dockerCompose(
  env: CommandEnvironment,
  composeFile: string,
  args: string[],
  options: Options = {}
) {
  return execa('docker', ['compose', '-f', composeFile, ...args], {
    cwd: dirname(composeFile),
    env,
    reject: true,
    ...options
  });
}

async function createPluginUpdateZip(fixtureRoot: string): Promise<void> {
  await mkdir(join(fixtureRoot, 'updates'), { recursive: true });
  await execa(
    'zip',
    ['-qr', join(fixtureRoot, 'updates/argus-regression-v2.zip'), 'argus-regression'],
    {
      cwd: join(fixtureRoot, 'update-package')
    }
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`zip command is required to build the deterministic plugin update package: ${message}`);
  });
}

async function removeDisposableTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) {
      throw error;
    }
    await execa('docker', [
      'run',
      '--rm',
      '-v',
      `${path}:/target`,
      'alpine:3.22',
      'chown',
      '-R',
      `${uid}:${gid}`,
      '/target'
    ]);
    await rm(path, { recursive: true, force: true });
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function gitStatus(): Promise<string> {
  return (
    await execa('git', ['status', '--short', '--untracked-files=all'], {
      cwd: repositoryRoot
    })
  ).stdout;
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) {
        const port = address.port;
        server.close(() => resolvePort(port));
      } else {
        server.close(() => rejectPort(new Error('Unable to reserve a TCP port')));
      }
    });
    server.on('error', rejectPort);
  });
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function extractRunId(output: string): string {
  const match = output.match(/^Run: ([A-Za-z0-9_-]+)$/m);
  if (!match) {
    throw new Error(`Missing run ID in output:\n${output}`);
  }
  return match[1]!;
}

function pluginVersion(inventory: Inventory, slug: string): string | undefined {
  return inventory.plugins.find((plugin) => plugin.slug === slug)?.version;
}

function pluginUpdateVersion(inventory: Inventory, slug: string): string | null | undefined {
  return inventory.plugins.find((plugin) => plugin.slug === slug)?.updateVersion;
}

type Inventory = {
  plugins: Array<{ slug: string; version: string; updateVersion: string | null }>;
};

type Report = {
  schemaVersion: number;
  site: { name: string; fingerprint: string } | null;
  reasonCodes: string[];
  commands: unknown[];
  inventory: {
    before: Inventory | null;
    after: Inventory | null;
  };
  checks: {
    baseline: Array<{ screenshotPath?: string }>;
    after: Array<{ screenshotPath?: string }>;
    visual: Array<{ diffPath?: string | null }>;
  };
  snapshot: { contentPath: string } | null;
};
