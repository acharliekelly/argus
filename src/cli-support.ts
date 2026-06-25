import type { ArgusReport } from './report.js';

export function createRunId(date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

export function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) {
    throw new Error(`Invalid run ID: ${runId}`);
  }
}

export function exitCodeForStatus(status: ArgusReport['status']): 0 | 1 {
  return status === 'passed' || status === 'rolled_back' ? 0 : 1;
}

export function exitCodeForReport(report: ArgusReport): 0 | 1 | 2 {
  if (report.reasonCodes.includes('preflight_failed')) {
    return 2;
  }
  return exitCodeForStatus(report.status);
}

export function renderReportSummary(report: ArgusReport): string {
  const reasons = report.reasonCodes.length > 0 ? report.reasonCodes.join(', ') : 'none';
  return [
    `Run: ${report.runId}`,
    `Target: ${report.target.type}:${report.target.slug}`,
    `Status: ${report.status}`,
    `Reasons: ${reasons}`,
    `Recommendation: ${report.recommendation}`
  ].join('\n');
}
