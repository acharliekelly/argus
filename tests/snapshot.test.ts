import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SnapshotService } from '../src/wordpress/snapshot.js';
import type { ProcessRunnerLike } from '../src/process.js';

function result(exitCode = 0) {
  return {
    command: 'docker',
    args: [],
    stdout: '',
    stderr: '',
    exitCode,
    durationMs: 1
  };
}

describe('SnapshotService', () => {
  it('exports the database before archiving wp-content', async () => {
    const order: string[] = [];
    const run = vi.fn<ProcessRunnerLike['run']>().mockImplementation(async (_command, args) => {
      order.push(args.includes('db') ? 'database' : 'content');
      return result();
    });
    const runBuffer = vi.fn<ProcessRunnerLike['runBuffer']>();
    const root = await mkdtemp(join(tmpdir(), 'argus-snapshot-'));
    const snapshots = new SnapshotService(
      { run, runBuffer },
      {
        composeFile: 'docker-compose.yml',
        wpCliService: 'wpcli',
        wordpressService: 'wordpress',
        artifactRoot: root
      }
    );

    const metadata = await snapshots.create('run-1');

    expect(order).toEqual(['database', 'content']);
    expect(metadata.databasePath).toContain('database.sql');
    expect(metadata.contentPath).toContain('wp-content.tar.gz');
  });

  it('restores SQL through the MariaDB client with TLS disabled and password in env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-snapshot-'));
    const runDirectory = join(root, 'runs', 'run-1', 'snapshot');
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, 'database.sql'), 'SELECT 1;');
    const responses = ['db:3306', 'wp_user', 'wp_password', 'wp_database'];
    const run = vi.fn<ProcessRunnerLike['run']>().mockImplementation(async (_command, args) => {
      if (args.includes('config')) {
        return { ...result(), stdout: responses.shift() ?? '' };
      }
      return result();
    });
    const runBuffer = vi.fn<ProcessRunnerLike['runBuffer']>();
    const snapshots = new SnapshotService(
      { run, runBuffer },
      {
        composeFile: 'docker-compose.yml',
        wpCliService: 'wpcli',
        wordpressService: 'wordpress',
        artifactRoot: root
      }
    );

    await snapshots.restore('run-1', {
      databasePath: 'snapshot/database.sql',
      contentPath: 'snapshot/wp-content.tar.gz',
      createdAt: new Date().toISOString()
    });

    const databaseCall = run.mock.calls.find(([, args]) => args.includes('mariadb'));
    expect(databaseCall?.[1]).toEqual(
      expect.arrayContaining([
        'mariadb',
        '--skip-ssl',
        '--host=db',
        '--port=3306',
        '--user=wp_user',
        'wp_database'
      ])
    );
    expect(databaseCall?.[1].join(' ')).not.toContain('wp_password');
    expect(databaseCall?.[2]).toMatchObject({
      env: expect.objectContaining({ MYSQL_PWD: 'wp_password' }),
      input: expect.any(Buffer)
    });
  });
});
