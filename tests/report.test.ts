import { describe, expect, it } from 'vitest';
import { createInitialReport, deriveRecommendation, redactValue } from '../src/report.js';

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

    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe('running');
  });
});
