import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../src/run-store.js';
import { DockerSnapshotService } from '../src/wordpress/docker-snapshot.js';
import type { BinaryCommandResult } from '../src/process.js';
import type { CommandRecord } from '../src/types.js';

function result(stdout = '', exitCode = 0): CommandRecord {
  return {
    command: 'docker',
    args: [],
    stdout,
    stderr: '',
    exitCode,
    durationMs: 1
  };
}

function bufferResult(stdout: Buffer, exitCode = 0): BinaryCommandResult {
  return {
    command: 'docker',
    args: [],
    stdout,
    stderr: '',
    exitCode,
    durationMs: 1
  };
}

function createHelper() {
  return {
    runWp: vi.fn(),
    runUtility: vi.fn(),
    runUtilityBuffer: vi.fn()
  };
}

describe('DockerSnapshotService', () => {
  it('exports database and wp-content snapshots to run-store paths without /argus mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-docker-snapshot-'));
    const store = new RunStore(root);
    await store.createRun('run-1');
    const helper = createHelper();
    helper.runWp.mockResolvedValueOnce(result('SQL DUMP'));
    helper.runUtilityBuffer.mockResolvedValueOnce(bufferResult(Buffer.from('archive')));
    const snapshots = new DockerSnapshotService(helper, store);

    const metadata = await snapshots.create('run-1');

    expect(helper.runWp).toHaveBeenCalledWith(['db', 'export', '-', '--skip-ssl']);
    expect(helper.runUtilityBuffer).toHaveBeenCalledWith([
      'tar',
      '-czf',
      '-',
      '-C',
      '/var/www/html',
      'wp-content'
    ]);
    expect(JSON.stringify(helper.runWp.mock.calls)).not.toContain('/argus');
    expect(JSON.stringify(helper.runUtilityBuffer.mock.calls)).not.toContain('/argus');
    await expect(readFile(store.runPath('run-1', 'snapshot/database.sql'), 'utf8')).resolves.toBe(
      'SQL DUMP'
    );
    await expect(
      readFile(store.runPath('run-1', 'snapshot/wp-content.tar.gz'))
    ).resolves.toEqual(Buffer.from('archive'));
    await expect(readdir(store.runPath('run-1', 'snapshot'))).resolves.toEqual([
      'database.sql',
      'wp-content.tar.gz'
    ]);
    expect(metadata).toMatchObject({
      databasePath: 'snapshot/database.sql',
      contentPath: 'snapshot/wp-content.tar.gz'
    });
  });

  it('restores host snapshot files through helper streams', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-docker-snapshot-'));
    const store = new RunStore(root);
    await store.createRun('run-1');
    await mkdir(store.runPath('run-1', 'snapshot'), { recursive: true });
    await writeFile(store.runPath('run-1', 'snapshot/database.sql'), 'SELECT 1;');
    await writeFile(store.runPath('run-1', 'snapshot/wp-content.tar.gz'), Buffer.from('archive'));
    const helper = createHelper();
    helper.runUtility.mockResolvedValue(result(''));
    helper.runWp
      .mockResolvedValueOnce(result('db:3306'))
      .mockResolvedValueOnce(result('wp_user'))
      .mockResolvedValueOnce(result('wp_database'));
    const snapshots = new DockerSnapshotService(helper, store);

    await snapshots.restore('run-1', {
      databasePath: 'snapshot/database.sql',
      contentPath: 'snapshot/wp-content.tar.gz',
      createdAt: new Date().toISOString()
    });

    expect(helper.runUtility).toHaveBeenNthCalledWith(
      1,
      ['sh', '-lc', 'rm -rf /var/www/html/wp-content && tar -xzf - -C /var/www/html'],
      Buffer.from('archive')
    );
    expect(helper.runWp).toHaveBeenNthCalledWith(1, ['config', 'get', 'DB_HOST']);
    expect(helper.runWp).toHaveBeenNthCalledWith(2, ['config', 'get', 'DB_USER']);
    expect(helper.runWp).toHaveBeenNthCalledWith(3, ['config', 'get', 'DB_NAME']);
    expect(helper.runUtility).toHaveBeenNthCalledWith(
      2,
      [
        'sh',
        '-lc',
        'MYSQL_PWD="$WORDPRESS_DB_PASSWORD" exec mariadb --skip-ssl --host="$1" --port="$2" --user="$3" "$4"',
        'mariadb-restore',
        'db',
        '3306',
        'wp_user',
        'wp_database'
      ],
      Buffer.from('SELECT 1;')
    );
    expect(JSON.stringify(helper.runUtility.mock.calls)).toContain('WORDPRESS_DB_PASSWORD');
    expect(JSON.stringify(helper.runUtility.mock.calls)).not.toContain('super-secret');
    expect(JSON.stringify(helper.runUtility.mock.calls)).not.toContain('/argus');
  });

  it('restores database without a port using WORDPRESS_DB_PASSWORD as MYSQL_PWD', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-docker-snapshot-'));
    const store = new RunStore(root);
    await store.createRun('run-1');
    await mkdir(store.runPath('run-1', 'snapshot'), { recursive: true });
    await writeFile(store.runPath('run-1', 'snapshot/database.sql'), 'SELECT 1;');
    await writeFile(store.runPath('run-1', 'snapshot/wp-content.tar.gz'), Buffer.from('archive'));
    const helper = createHelper();
    helper.runUtility.mockResolvedValue(result(''));
    helper.runWp
      .mockResolvedValueOnce(result('db'))
      .mockResolvedValueOnce(result('wp_user'))
      .mockResolvedValueOnce(result('wp_database'));
    const snapshots = new DockerSnapshotService(helper, store);

    await snapshots.restore('run-1', {
      databasePath: 'snapshot/database.sql',
      contentPath: 'snapshot/wp-content.tar.gz',
      createdAt: new Date().toISOString()
    });

    expect(helper.runUtility).toHaveBeenNthCalledWith(
      2,
      [
        'sh',
        '-lc',
        'MYSQL_PWD="$WORDPRESS_DB_PASSWORD" exec mariadb --skip-ssl --host="$1" --user="$2" "$3"',
        'mariadb-restore',
        'db',
        'wp_user',
        'wp_database'
      ],
      Buffer.from('SELECT 1;')
    );
    expect(JSON.stringify(helper.runUtility.mock.calls)).toContain('WORDPRESS_DB_PASSWORD');
    expect(JSON.stringify(helper.runUtility.mock.calls)).not.toContain('super-secret');
    expect(JSON.stringify(helper.runUtility.mock.calls)).not.toContain('/argus');
  });

  it('rejects restore metadata paths that escape the run directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-docker-snapshot-'));
    const store = new RunStore(root);
    const snapshots = new DockerSnapshotService(createHelper(), store);

    await expect(
      snapshots.restore('run-1', {
        databasePath: '../database.sql',
        contentPath: 'snapshot/wp-content.tar.gz',
        createdAt: new Date().toISOString()
      })
    ).rejects.toThrow(/outside run directory/i);
  });
});
