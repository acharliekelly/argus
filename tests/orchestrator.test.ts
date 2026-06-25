import { mkdtemp } from 'node:fs/promises';
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

async function createHarness(results: boolean[]) {
  const root = await mkdtemp(join(tmpdir(), 'argus-orchestrator-'));
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
      store: new RunStore(root)
    },
    []
  );
  return { orchestrator, wordpress, snapshots, browser };
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
});
