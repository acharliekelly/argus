import {
  ProcessRunner,
  type BinaryCommandResult,
  type ProcessRunnerLike,
  type RunOptions
} from '../process.js';
import type { CommandRecord } from '../types.js';

const WORDPRESS_ROOT = '/var/www/html' as const;
const UTILITY_IMAGE = 'alpine:3.22' as const;
const DEFAULT_HELPER_IMAGE = 'wordpress:cli' as const;
const WORDPRESS_DATABASE_ENVIRONMENT_KEYS = [
  'WORDPRESS_DB_HOST',
  'WORDPRESS_DB_NAME',
  'WORDPRESS_DB_USER',
  'WORDPRESS_DB_PASSWORD'
] as const;

type HelperSite = {
  containerId: string;
  networkName: string;
  helperImage?: string;
  wordpressEnvironment?: Record<string, string>;
};

export class DockerSiteHelper {
  private readonly containerId: string;
  private readonly networkName: string;
  private readonly helperImage: string;
  private readonly wordpressEnvironment: Record<string, string>;
  private readonly runner: ProcessRunnerLike;

  constructor(site: HelperSite, runner: ProcessRunnerLike = new ProcessRunner()) {
    this.containerId = site.containerId;
    this.networkName = site.networkName;
    this.helperImage = site.helperImage ?? DEFAULT_HELPER_IMAGE;
    this.wordpressEnvironment = site.wordpressEnvironment ?? {};
    this.runner = runner;
  }

  async runWp(args: string[]): Promise<CommandRecord> {
    return this.runText(this.helperImage, ['wp', ...args, '--allow-root']);
  }

  async runUtility(args: string[], input?: Buffer): Promise<CommandRecord> {
    return this.runText(UTILITY_IMAGE, args, input === undefined ? {} : { input });
  }

  async runUtilityBuffer(args: string[]): Promise<BinaryCommandResult> {
    try {
      const result = await this.runner.runBuffer(
        'docker',
        this.dockerArgs(UTILITY_IMAGE, args),
        this.runOptions()
      );
      return this.redactBinaryRecord(result);
    } catch (error) {
      throw this.redactError(error);
    }
  }

  private async runText(
    image: string,
    args: string[],
    options: Pick<RunOptions, 'input'> = {}
  ): Promise<CommandRecord> {
    try {
      const result = await this.runner.run('docker', this.dockerArgs(image, args), {
        ...this.runOptions(),
        ...options
      });
      return this.redactRecord(result);
    } catch (error) {
      throw this.redactError(error);
    }
  }

  private dockerArgs(image: string, args: string[]): string[] {
    return [
      'run',
      '--rm',
      '--network',
      this.networkName,
      '--volumes-from',
      this.containerId,
      '-w',
      WORDPRESS_ROOT,
      ...this.environmentArgs(),
      image,
      ...args
    ];
  }

  private environmentArgs(): string[] {
    return WORDPRESS_DATABASE_ENVIRONMENT_KEYS.flatMap((name) =>
      this.wordpressEnvironment[name] === undefined ? [] : ['-e', name]
    );
  }

  private runOptions(): RunOptions {
    return {
      env: {
        ...process.env,
        ...Object.fromEntries(
          WORDPRESS_DATABASE_ENVIRONMENT_KEYS.flatMap((name) => {
            const value = this.wordpressEnvironment[name];
            return value === undefined ? [] : [[name, value]];
          })
        )
      }
    };
  }

  private redactRecord(result: CommandRecord): CommandRecord {
    return {
      ...result,
      command: this.redactText(result.command),
      args: result.args.map((arg) => this.redactText(arg)),
      stdout: this.redactText(result.stdout),
      stderr: this.redactText(result.stderr)
    };
  }

  private redactBinaryRecord(result: BinaryCommandResult): BinaryCommandResult {
    return {
      ...result,
      command: this.redactText(result.command),
      args: result.args.map((arg) => this.redactText(arg)),
      stderr: this.redactText(result.stderr)
    };
  }

  private redactError(error: unknown): Error {
    if (error instanceof Error) {
      const redacted = new Error(this.redactText(error.message));
      redacted.name = error.name;
      if (error.stack) {
        redacted.stack = this.redactText(error.stack);
      }
      return redacted;
    }
    return new Error(this.redactText(String(error)));
  }

  private redactText(value: string): string {
    return this.secretValues().reduce(
      (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
      value
    );
  }

  private secretValues(): string[] {
    return Object.values(this.wordpressEnvironment).filter((value) => value.length > 0);
  }
}
