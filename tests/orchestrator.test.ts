import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MaintenanceOrchestrator } from '../src/orchestrator.js';
import { RunStore } from '../src/run-store.js';
import type { SiteInventory } from '../src/types.js';

const beforeInventory: SiteInventory = {
  core: { version: '7.0', updateVersion: null },
  plugins: [
    { slug: 'demo', status: 'active', version: '1.0.0', updateVersion: '2.0.0' }
  ],
  themes: []
};

const afterInventory: SiteInventory = {
  ...beforeInventory,
  plugins: [
    { slug: 'demo', status: 'active', version: '2.0.0', updateVersion: null }
  ]
};

function browserResult(passed: boolean) {
  return {
    passed,
    checks: [{ scenario: 'home', viewport: 'desktop', passed, screenshotPath: 'shot.png' }]
  };
}

type SiteIdentity = { name: string; fingerprint: string };

async function createHarness(results: boolean[], siteIdentity?: SiteIdentity) {
  const root = await mkdtemp(join(tmpdir(), 'argus-orchestrator-'));
  const store = new RunStore(root);
  const wordpress = {
    preflight: vi.fn().mockResolvedValue([{ name: 'wpcli', passed: true, message: 'ok' }]),
    inventory: vi
      .fn()
      .mockResolvedValueOnce(beforeInventory)
      .mockResolvedValueOnce(afterInventory),
    update: vi.fn().mockResolvedValue({
      command: 'docker',
      args: [],
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 1
    })
  };
  const snapshots = {
    create: vi.fn().mockResolvedValue({
      databasePath: 'snapshot/database.sql',
      contentPath: 'snapshot/wp-content.tar.gz',
      createdAt: new Date().toISOString()
    }),
    restore: vi.fn()
  };
  const browser = {
    run: vi.fn().mockImplementation(async () => browserResult(results.shift() ?? true)),
    compare: vi.fn().mockImplementation(async () => ({
      passed: results.shift() ?? true,
      comparisons: []
    }))
  };
  const orchestrator = new MaintenanceOrchestrator(
    {
      wordpress,
      snapshots,
      browser,
      store
    },
    [],
    siteIdentity ? { siteIdentity } : {}
  );
  return { orchestrator, wordpress, snapshots, browser, store };
}

async function writeRollbackReport(
  store: RunStore,
  runId: string,
  report: Record<string, unknown>
) {
  await store.createRun(runId);
  await store.ensureRunDirectory(runId, 'snapshot');
  await writeFile(store.runPath(runId, 'snapshot/database.sql'), '');
  await writeFile(store.runPath(runId, 'snapshot/wp-content.tar.gz'), '');
  await store.writeJson(runId, 'report.json', report);
}

describe('MaintenanceOrchestrator', () => {
  it('does not snapshot or update when baseline checks fail', async () => {
    const { orchestrator, wordpress, snapshots } = await createHarness([false]);

    const report = await orchestrator.update(
      { type: 'plugin', slug: 'demo' },
      'run-baseline-fail'
    );

    expect(report.status).toBe('failed');
    expect(report.reasonCodes).toContain('baseline_failed');
    expect(snapshots.create).not.toHaveBeenCalled();
    expect(wordpress.update).not.toHaveBeenCalled();
  });

  it('snapshots before updating and recommends acceptance when gates pass', async () => {
    const { orchestrator, wordpress, snapshots } = await createHarness([true, true, true]);
    const order: string[] = [];
    snapshots.create.mockImplementation(async () => {
      order.push('snapshot');
      return {
        databasePath: 'snapshot/database.sql',
        contentPath: 'snapshot/wp-content.tar.gz',
        createdAt: new Date().toISOString()
      };
    });
    wordpress.update.mockImplementation(async () => {
      order.push('update');
      return {
        command: 'docker',
        args: [],
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 1
      };
    });

    const report = await orchestrator.update({ type: 'plugin', slug: 'demo' }, 'run-pass');

    expect(order).toEqual(['snapshot', 'update']);
    expect(report.status).toBe('passed');
    expect(report.recommendation).toBe('accept');
  });

  it('recommends rollback for a visual regression', async () => {
    const { orchestrator } = await createHarness([true, true, false]);

    const report = await orchestrator.update(
      { type: 'plugin', slug: 'demo' },
      'run-regression'
    );

    expect(report.status).toBe('failed');
    expect(report.reasonCodes).toContain('visual_regression');
    expect(report.recommendation).toBe('rollback');
  });

  it('preserves a failed update command in the report', async () => {
    const { orchestrator, wordpress } = await createHarness([true]);
    wordpress.update.mockResolvedValue({
      command: 'docker',
      args: ['compose', 'run', 'wpcli', 'wp', 'plugin', 'update', 'demo'],
      stdout: '',
      stderr: 'download failed',
      exitCode: 1,
      durationMs: 10
    });

    const report = await orchestrator.update(
      { type: 'plugin', slug: 'demo' },
      'run-update-fail'
    );

    expect(report.status).toBe('failed');
    expect(report.reasonCodes).toContain('update_failed');
    expect(report.commands).toHaveLength(1);
    expect(report.commands[0]?.exitCode).toBe(1);
  });

  it('writes selected site identity into named-mode reports', async () => {
    const siteIdentity = { name: 'melrose', fingerprint: 'sha256:abc123' };
    const { orchestrator } = await createHarness([true, true, true], siteIdentity);

    const report = await orchestrator.update({ type: 'plugin', slug: 'demo' }, 'run-named');

    expect(report.site).toEqual(siteIdentity);
  });

  it('writes null site identity in config-mode reports', async () => {
    const { orchestrator } = await createHarness([true, true, true]);

    const report = await orchestrator.update({ type: 'plugin', slug: 'demo' }, 'run-config');

    expect(report.site).toBeNull();
  });

  it('rejects named-site rollback for legacy schema-v1 reports', async () => {
    const siteIdentity = { name: 'melrose', fingerprint: 'sha256:abc123' };
    const { orchestrator, snapshots, store } = await createHarness([], siteIdentity);
    await writeRollbackReport(store, 'run-v1', {
      schemaVersion: 1,
      runId: 'run-v1',
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: 'failed',
      target: { type: 'plugin', slug: 'demo' },
      reasonCodes: [],
      recommendation: 'rollback',
      inventory: { before: null, after: null },
      preflight: [],
      commands: [],
      checks: { baseline: [], after: [], visual: [], rollback: [] },
      snapshot: {
        databasePath: 'snapshot/database.sql',
        contentPath: 'snapshot/wp-content.tar.gz',
        createdAt: new Date().toISOString()
      },
      rollback: null
    });

    await expect(orchestrator.rollback('run-v1')).rejects.toThrow('target_fingerprint_mismatch');
    expect(snapshots.restore).not.toHaveBeenCalled();
  });

  it('rejects named-site rollback when report identity differs', async () => {
    const siteIdentity = { name: 'melrose', fingerprint: 'sha256:abc123' };
    const { orchestrator, snapshots, store } = await createHarness([], siteIdentity);
    await writeRollbackReport(store, 'run-other-site', {
      schemaVersion: 2,
      site: { name: 'argus-dev', fingerprint: 'sha256:different' },
      runId: 'run-other-site',
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: 'failed',
      target: { type: 'plugin', slug: 'demo' },
      reasonCodes: [],
      recommendation: 'rollback',
      inventory: { before: null, after: null },
      preflight: [],
      commands: [],
      checks: { baseline: [], after: [], visual: [], rollback: [] },
      snapshot: {
        databasePath: 'snapshot/database.sql',
        contentPath: 'snapshot/wp-content.tar.gz',
        createdAt: new Date().toISOString()
      },
      rollback: null
    });

    await expect(orchestrator.rollback('run-other-site')).rejects.toThrow(
      'target_fingerprint_mismatch'
    );
    expect(snapshots.restore).not.toHaveBeenCalled();
  });
});
