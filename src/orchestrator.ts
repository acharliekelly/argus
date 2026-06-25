import { access } from 'node:fs/promises';
import { reportSchema, createInitialReport, deriveRecommendation, redactValue } from './report.js';
import type { ArgusReport } from './report.js';
import type { RunStore } from './run-store.js';
import type { CommandRecord, SiteInventory, UpdateTarget } from './types.js';
import { assertUpdateEligible } from './wordpress/inventory.js';
import type { PreflightCheck } from './wordpress/adapter.js';
import type { SnapshotMetadata } from './wordpress/snapshot.js';

export type BrowserRunResult = {
  passed: boolean;
  checks: unknown[];
};

export type BrowserComparisonResult = {
  passed: boolean;
  comparisons: unknown[];
};

type OrchestratorDependencies = {
  wordpress: {
    preflight(): Promise<PreflightCheck[]>;
    inventory(): Promise<SiteInventory>;
    update(target: UpdateTarget): Promise<CommandRecord>;
  };
  snapshots: {
    create(runId: string): Promise<SnapshotMetadata>;
    restore(runId: string, metadata: SnapshotMetadata): Promise<void>;
  };
  browser: {
    run(runId: string, phase: 'baseline' | 'after' | 'rollback'): Promise<BrowserRunResult>;
    compare(runId: string): Promise<BrowserComparisonResult>;
  };
  store: RunStore;
};

export class MaintenanceOrchestrator {
  constructor(
    private readonly dependencies: OrchestratorDependencies,
    private readonly secretValues: string[]
  ) {}

  private async persist(report: ArgusReport): Promise<void> {
    const redacted = redactValue(report, this.secretValues);
    reportSchema.parse(redacted);
    await this.dependencies.store.writeJson(report.runId, 'report.json', redacted);
  }

  async update(target: UpdateTarget, runId: string): Promise<ArgusReport> {
    const report = createInitialReport(runId, target);
    await this.dependencies.store.createRun(runId);
    await this.persist(report);

    try {
      report.preflight = await this.dependencies.wordpress.preflight();
      if (report.preflight.some(({ passed }) => !passed)) {
        report.status = 'failed';
        report.reasonCodes.push('preflight_failed');
        return await this.finish(report);
      }

      report.inventory.before = await this.dependencies.wordpress.inventory();
      assertUpdateEligible(report.inventory.before, target);
      await this.persist(report);

      const baseline = await this.dependencies.browser.run(runId, 'baseline');
      report.checks.baseline = baseline.checks;
      if (!baseline.passed) {
        report.status = 'failed';
        report.reasonCodes.push('baseline_failed');
        return await this.finish(report);
      }

      report.snapshot = await this.dependencies.snapshots.create(runId);
      await this.persist(report);

      const updateCommand = await this.dependencies.wordpress.update(target);
      report.commands.push(updateCommand);
      if (updateCommand.exitCode !== 0) {
        throw new Error(
          `update_failed: ${updateCommand.stderr || updateCommand.stdout || 'unknown error'}`
        );
      }
      report.inventory.after = await this.dependencies.wordpress.inventory();
      const after = await this.dependencies.browser.run(runId, 'after');
      report.checks.after = after.checks;
      const visual = await this.dependencies.browser.compare(runId);
      report.checks.visual = visual.comparisons;

      const postUpdatePassed = after.passed;
      if (!postUpdatePassed) {
        report.reasonCodes.push('functional_regression');
      }
      if (!visual.passed) {
        report.reasonCodes.push('visual_regression');
      }
      report.recommendation = deriveRecommendation({
        baselinePassed: true,
        updatePassed: true,
        postUpdatePassed,
        visualPassed: visual.passed
      });
      report.status = postUpdatePassed && visual.passed ? 'passed' : 'failed';
      return await this.finish(report);
    } catch (error) {
      report.status = 'failed';
      report.reasonCodes.push(classifyError(error));
      return await this.finish(report);
    }
  }

  async rollback(runId: string): Promise<ArgusReport> {
    const report = await this.dependencies.store.readJson<ArgusReport>(runId, 'report.json');
    reportSchema.parse(report);
    if (!report.snapshot) {
      throw new Error(`snapshot_missing: run ${runId} has no restorable snapshot`);
    }

    await access(this.dependencies.store.runPath(runId, report.snapshot.databasePath));
    await access(this.dependencies.store.runPath(runId, report.snapshot.contentPath));
    await this.dependencies.snapshots.restore(runId, report.snapshot);
    const checks = await this.dependencies.browser.run(runId, 'rollback');
    report.checks.rollback = checks.checks;
    report.rollback = {
      completedAt: new Date().toISOString(),
      passed: checks.passed
    };
    report.status = checks.passed ? 'rolled_back' : 'failed';
    report.recommendation = checks.passed ? 'investigate' : 'rollback';
    if (!checks.passed) {
      report.reasonCodes.push('rollback_validation_failed');
    }
    return this.finish(report);
  }

  private async finish(report: ArgusReport): Promise<ArgusReport> {
    report.completedAt = new Date().toISOString();
    await this.persist(report);
    return report;
  }
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const known = [
    'unsupported_target',
    'component_not_found',
    'no_update_available',
    'snapshot_missing',
    'snapshot_failed',
    'update_failed',
    'inventory_failed'
  ];
  const knownCode = known.find((code) => message.includes(code));
  if (knownCode) {
    return knownCode;
  }
  if (/snapshot|export wordpress database|archive wordpress content/i.test(message)) {
    return 'snapshot_failed';
  }
  if (/update (plugin|theme)/i.test(message)) {
    return 'update_failed';
  }
  if (/inventory|read .* (version|updates)/i.test(message)) {
    return 'inventory_failed';
  }
  return 'unexpected_failure';
}
