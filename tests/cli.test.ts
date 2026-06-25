import { describe, expect, it } from 'vitest';
import { createRunId, exitCodeForStatus, renderReportSummary } from '../src/cli-support.js';
import { createInitialReport } from '../src/report.js';

describe('CLI support', () => {
  it('creates filesystem-safe run IDs', () => {
    expect(createRunId(new Date('2026-06-25T03:04:05.678Z'))).toBe(
      '20260625T030405678Z'
    );
  });

  it('maps passed and rolled-back reports to success', () => {
    expect(exitCodeForStatus('passed')).toBe(0);
    expect(exitCodeForStatus('rolled_back')).toBe(0);
    expect(exitCodeForStatus('failed')).toBe(1);
    expect(exitCodeForStatus('aborted')).toBe(1);
  });

  it('renders a concise summary from report data', () => {
    const report = createInitialReport('run-1', { type: 'plugin', slug: 'demo' });
    report.status = 'failed';
    report.recommendation = 'rollback';
    report.reasonCodes = ['visual_regression'];

    expect(renderReportSummary(report)).toContain('run-1');
    expect(renderReportSummary(report)).toContain('visual_regression');
    expect(renderReportSummary(report)).toContain('rollback');
  });
});
