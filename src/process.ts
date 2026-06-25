import { execa } from 'execa';
import type { CommandRecord } from './types.js';

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
};

export interface ProcessRunnerLike {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandRecord>;
}

export class ProcessRunner implements ProcessRunnerLike {
  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandRecord> {
    const startedAt = performance.now();
    const executionOptions = {
      reject: false,
      stripFinalNewline: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.input ? { input: options.input } : {})
    };
    const result = await execa(command, args, executionOptions);

    return {
      command,
      args,
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.round(performance.now() - startedAt)
    };
  }
}

export function assertCommandPassed(result: CommandRecord, context: string): CommandRecord {
  if (result.exitCode !== 0) {
    throw new Error(
      `${context} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
  return result;
}
