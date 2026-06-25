import { describe, expect, it } from 'vitest';
import { ProcessRunner } from '../src/process.js';

describe('ProcessRunner', () => {
  it('captures command output, duration, and exit status', async () => {
    const runner = new ProcessRunner();
    const result = await runner.run('/bin/sh', ['-c', 'printf ok']);

    expect(result).toMatchObject({
      command: '/bin/sh',
      stdout: 'ok',
      stderr: '',
      exitCode: 0
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not throw for a failed command', async () => {
    const runner = new ProcessRunner();
    const result = await runner.run('/bin/sh', ['-c', 'printf bad >&2; exit 7']);

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe('bad');
  });
});
