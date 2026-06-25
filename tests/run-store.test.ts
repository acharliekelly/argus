import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunLock, RunStore } from '../src/run-store.js';

describe('RunStore', () => {
  it('writes reports atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-store-'));
    const store = new RunStore(root);
    await store.createRun('run-1');
    await store.writeJson('run-1', 'report.json', { ok: true });

    await expect(
      readFile(join(root, 'runs', 'run-1', 'report.json'), 'utf8').then(JSON.parse)
    ).resolves.toEqual({ ok: true });
  });

  it('rejects paths that escape a run directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-store-'));
    const store = new RunStore(root);

    expect(() => store.runPath('run-1', '../../outside')).toThrow(/outside run directory/i);
  });
});

describe('RunLock', () => {
  it('rejects an active lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-lock-'));
    const lock = new RunLock(root, () => true);
    await lock.acquire('run-1');

    await expect(lock.acquire('run-2')).rejects.toThrow(/maintenance run is active/i);
  });

  it('replaces a stale lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-lock-'));
    await writeFile(join(root, 'lock.json'), JSON.stringify({ pid: 999999, runId: 'old' }));
    const lock = new RunLock(root, () => false);

    await lock.acquire('new');

    await expect(readFile(join(root, 'lock.json'), 'utf8').then(JSON.parse)).resolves.toMatchObject({
      runId: 'new'
    });
  });
});
