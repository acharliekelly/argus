import { describe, expect, it, vi } from 'vitest';
import { DockerSiteHelper } from '../src/sites/helper.js';
import type { BinaryCommandResult, ProcessRunnerLike } from '../src/process.js';
import type { CommandRecord } from '../src/types.js';

const secretPassword = 'super-secret-db-password';

const site = {
  containerId: 'wordpress-container-id',
  networkName: 'project_default',
  helperImage: 'wordpress:cli',
  wordpressEnvironment: {
    WORDPRESS_DB_HOST: 'db:3306',
    WORDPRESS_DB_NAME: 'wordpress',
    WORDPRESS_DB_USER: 'wp_user',
    WORDPRESS_DB_PASSWORD: secretPassword
  }
};

function commandResult(args: string[], overrides: Partial<CommandRecord> = {}): CommandRecord {
  return {
    command: 'docker',
    args,
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    ...overrides
  };
}

function binaryResult(args: string[], stdout = Buffer.from('archive')): BinaryCommandResult {
  return {
    command: 'docker',
    args,
    stdout,
    stderr: '',
    exitCode: 0,
    durationMs: 1
  };
}

describe('DockerSiteHelper', () => {
  it('runs WP commands in an ephemeral helper container with database env names only', async () => {
    const run = vi.fn<ProcessRunnerLike['run']>().mockImplementation(async (_command, args) => {
      return commandResult(args);
    });
    const runBuffer = vi.fn<ProcessRunnerLike['runBuffer']>();
    const helper = new DockerSiteHelper(site, { run, runBuffer });

    await helper.runWp(['plugin', 'list']);

    expect(run).toHaveBeenCalledWith(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'project_default',
        '--volumes-from',
        'wordpress-container-id',
        '-w',
        '/var/www/html',
        '-e',
        'WORDPRESS_DB_HOST',
        '-e',
        'WORDPRESS_DB_NAME',
        '-e',
        'WORDPRESS_DB_USER',
        '-e',
        'WORDPRESS_DB_PASSWORD',
        'wordpress:cli',
        'wp',
        'plugin',
        'list',
        '--allow-root'
      ],
      {
        env: expect.objectContaining({
          WORDPRESS_DB_PASSWORD: secretPassword
        })
      }
    );
    expect(run.mock.calls[0]?.[1].join(' ')).not.toContain(secretPassword);
  });

  it('passes buffer input to WP commands without putting secrets in command args or records', async () => {
    const sql = Buffer.from('CREATE TABLE example (secret varchar(255));');
    const run = vi.fn<ProcessRunnerLike['run']>().mockImplementation(async (_command, args) => {
      return commandResult(args, {
        stdout: `imported with ${secretPassword}`,
        stderr: ''
      });
    });
    const runBuffer = vi.fn<ProcessRunnerLike['runBuffer']>();
    const helper = new DockerSiteHelper(site, { run, runBuffer });

    const record = await helper.runWp(['db', 'import', '-', '--skip-ssl'], sql);

    expect(run).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'wordpress:cli',
        'wp',
        'db',
        'import',
        '-',
        '--skip-ssl',
        '--allow-root'
      ]),
      expect.objectContaining({
        input: sql,
        env: expect.objectContaining({
          WORDPRESS_DB_PASSWORD: secretPassword
        })
      })
    );
    expect(run.mock.calls[0]?.[1]).toContain('--interactive');
    expect(JSON.stringify(run.mock.calls[0]?.[1])).not.toContain(secretPassword);
    expect(JSON.stringify(record)).not.toContain(secretPassword);
    expect(record.stdout).toContain('[REDACTED]');
  });

  it('redacts environment values from returned command records', async () => {
    const run = vi.fn<ProcessRunnerLike['run']>().mockResolvedValue(
      commandResult([], {
        stderr: `failed with ${secretPassword}`,
        stdout: `stdout ${secretPassword}`
      })
    );
    const runBuffer = vi.fn<ProcessRunnerLike['runBuffer']>();
    const helper = new DockerSiteHelper(site, { run, runBuffer });

    const result = await helper.runWp(['core', 'version']);

    expect(JSON.stringify(result)).not.toContain(secretPassword);
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stderr).toContain('[REDACTED]');
  });

  it('redacts environment values from thrown errors', async () => {
    const run = vi.fn<ProcessRunnerLike['run']>().mockRejectedValue(
      new Error(`docker failed with ${secretPassword}`)
    );
    const runBuffer = vi.fn<ProcessRunnerLike['runBuffer']>();
    const helper = new DockerSiteHelper(site, { run, runBuffer });

    await expect(helper.runWp(['core', 'version'])).rejects.toThrow('[REDACTED]');
    await expect(helper.runWp(['core', 'version'])).rejects.not.toThrow(secretPassword);
  });

  it('runs binary utility archives through alpine with binary stdout', async () => {
    const archive = Buffer.from('archive');
    const run = vi.fn<ProcessRunnerLike['run']>();
    const runBuffer = vi.fn<ProcessRunnerLike['runBuffer']>(async (_command, args) =>
      binaryResult(args, archive)
    );
    const helper = new DockerSiteHelper(site, { run, runBuffer });

    const result = await helper.runUtilityBuffer([
      'tar',
      '-czf',
      '-',
      '-C',
      '/var/www/html',
      'wp-content'
    ]);

    expect(result.stdout).toEqual(archive);
    expect(runBuffer).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'run',
        '--rm',
        '--network',
        'project_default',
        '--volumes-from',
        'wordpress-container-id',
        '-w',
        '/var/www/html',
        'alpine:3.22',
        'tar',
        '-czf',
        '-',
        '-C',
        '/var/www/html',
        'wp-content'
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          WORDPRESS_DB_PASSWORD: secretPassword
        })
      })
    );
  });

  it('runs binary utility restores through alpine with interactive buffer input', async () => {
    const archive = Buffer.from('archive');
    const run = vi.fn<ProcessRunnerLike['run']>();
    const runBuffer = vi.fn<ProcessRunnerLike['runBuffer']>(async (_command, args) =>
      binaryResult(args)
    );
    const helper = new DockerSiteHelper(site, { run, runBuffer });

    await helper.runUtilityBuffer(['tar', '-xzf', '-', '-C', '/var/www/html'], archive);

    expect(runBuffer).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining([
        'run',
        '--rm',
        '--interactive',
        '--network',
        'project_default',
        '--volumes-from',
        'wordpress-container-id',
        '-w',
        '/var/www/html',
        'alpine:3.22',
        'tar',
        '-xzf',
        '-',
        '-C',
        '/var/www/html'
      ]),
      expect.objectContaining({
        input: archive,
        env: expect.objectContaining({
          WORDPRESS_DB_PASSWORD: secretPassword
        })
      })
    );
  });
});
