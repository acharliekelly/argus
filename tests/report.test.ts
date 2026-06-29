import { describe, expect, it } from 'vitest';
import { createInitialReport, deriveRecommendation, redactValue, reportSchema } from '../src/report.js';

describe('reporting', () => {
  it('redacts secrets recursively', () => {
    expect(
      redactValue(
        {
          stdout: 'logged in with secret-token',
          nested: ['secret-token', { value: 'prefix-secret-token-suffix' }]
        },
        ['secret-token']
      )
    ).toEqual({
      stdout: 'logged in with [REDACTED]',
      nested: ['[REDACTED]', { value: 'prefix-[REDACTED]-suffix' }]
    });
  });

  it('recommends rollback for post-update regression', () => {
    expect(
      deriveRecommendation({
        baselinePassed: true,
        updatePassed: true,
        postUpdatePassed: false,
        visualPassed: true
      })
    ).toBe('rollback');
  });

  it('creates a schema-valid initial report', () => {
    const report = createInitialReport('run-1', {
      type: 'plugin',
      slug: 'demo'
    });

    expect(report.schemaVersion).toBe(2);
    expect(report.site).toBeNull();
    expect(report.status).toBe('running');
    expect(reportSchema.parse(report)).toEqual(report);
  });

  it('records site identity in new reports when supplied', () => {
    const report = createInitialReport(
      'run-1',
      {
        type: 'plugin',
        slug: 'demo'
      },
      { name: 'melrose', fingerprint: 'sha256:abc123' }
    );

    expect(report.site).toEqual({ name: 'melrose', fingerprint: 'sha256:abc123' });
  });

  it('parses legacy schema-v1 reports without site identity', () => {
    const legacyReport = {
      schemaVersion: 1,
      runId: 'run-legacy',
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: 'running',
      target: { type: 'plugin', slug: 'demo' },
      reasonCodes: [],
      recommendation: 'investigate',
      inventory: { before: null, after: null },
      preflight: [],
      commands: [],
      checks: { baseline: [], after: [], visual: [], rollback: [] },
      snapshot: null,
      rollback: null
    };

    expect(reportSchema.parse(legacyReport)).toMatchObject({
      schemaVersion: 1,
      runId: 'run-legacy'
    });
  });
});
