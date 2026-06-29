import { execa } from 'execa';
import type { CommandRecord } from './types.js';

export type BinaryCommandResult = Omit<CommandRecord, 'stdout' | 'stderr'> & {
  stdout: Buffer;
  stderr: string;
};

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
};

export interface ProcessRunnerLike {
  run(command: string, args: string[], options?: RunOptions): Promise<CommandRecord>;
  runBuffer(
    command: string,
    args: string[],
    options?: RunOptions
  ): Promise<BinaryCommandResult>;
}

export class ProcessRunner implements ProcessRunnerLike {
  async run(command: string, args: string[], options: RunOptions = {}): Promise<CommandRecord> {
    const startedAt = performance.now();
    const executionOptions = {
      reject: false,
      stripFinalNewline: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.input === undefined ? {} : { input: options.input })
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

  async runBuffer(
    command: string,
    args: string[],
    options: RunOptions = {}
  ): Promise<BinaryCommandResult> {
    const startedAt = performance.now();
    const executionOptions = {
      reject: false,
      stripFinalNewline: false,
      encoding: 'buffer',
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.input === undefined ? {} : { input: options.input })
    } as const;
    const result = await execa(command, args, executionOptions);

    return {
      command,
      args,
      exitCode: result.exitCode ?? 1,
      stdout: toBuffer(result.stdout),
      stderr: toBuffer(result.stderr).toString('utf8'),
      durationMs: Math.round(performance.now() - startedAt)
    };
  }
}

function toBuffer(value: string | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export function assertCommandPassed(result: CommandRecord, context: string): CommandRecord {
  if (result.exitCode !== 0) {
    throw new Error(
      `${context} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
  return result;
}
