import {
  ProcessRunner,
  type BinaryCommandResult,
  type ProcessRunnerLike,
  type RunOptions
} from '../process.js';
import type { CommandRecord } from '../types.js';

const WORDPRESS_ROOT = '/var/www/html' as const;
const UTILITY_IMAGE = 'alpine:3.22' as const;
const DATABASE_CLIENT_IMAGE = 'mysql:8.0' as const;
const DEFAULT_HELPER_IMAGE = 'wordpress:cli' as const;
const WORDPRESS_DATABASE_ENVIRONMENT_KEYS = [
  'WORDPRESS_DB_HOST',
  'WORDPRESS_DB_NAME',
  'WORDPRESS_DB_USER',
  'WORDPRESS_DB_PASSWORD',
  'WORDPRESS_TABLE_PREFIX',
  'HTTP_HOST'
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

  async runWp(args: string[], input?: Buffer): Promise<CommandRecord> {
    return this.runText(
      this.helperImage,
      ['wp', ...args, '--allow-root'],
      input === undefined ? {} : { input }
    );
  }

  async runUtility(args: string[], input?: Buffer): Promise<CommandRecord> {
    return this.runText(UTILITY_IMAGE, args, input === undefined ? {} : { input });
  }

  async runUtilityBuffer(args: string[], input?: Buffer): Promise<BinaryCommandResult> {
    try {
      const result = await this.runner.runBuffer(
        'docker',
        this.dockerArgs(UTILITY_IMAGE, args, input !== undefined),
        input === undefined ? this.runOptions() : { ...this.runOptions(), input }
      );
      return this.redactBinaryRecord(result);
    } catch (error) {
      throw this.redactError(error);
    }
  }

  async runDatabaseClient(args: string[], input?: Buffer): Promise<CommandRecord> {
    try {
      const result = await this.runner.run(
        'docker',
        this.databaseClientDockerArgs(args, input !== undefined),
        input === undefined ? this.databaseRunOptions() : { ...this.databaseRunOptions(), input }
      );
      return this.redactRecord(result);
    } catch (error) {
      throw this.redactError(error);
    }
  }

  async runDatabaseClientBuffer(
    args: string[],
    input?: Buffer
  ): Promise<BinaryCommandResult> {
    try {
      const result = await this.runner.runBuffer(
        'docker',
        this.databaseClientDockerArgs(args, input !== undefined),
        input === undefined ? this.databaseRunOptions() : { ...this.databaseRunOptions(), input }
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
      const result = await this.runner.run('docker', this.dockerArgs(image, args, options.input !== undefined), {
        ...this.runOptions(),
        ...options
      });
      return this.redactRecord(result);
    } catch (error) {
      throw this.redactError(error);
    }
  }

  private dockerArgs(image: string, args: string[], interactive = false): string[] {
    return [
      'run',
      '--rm',
      ...(interactive ? ['--interactive'] : []),
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

  private databaseClientDockerArgs(args: string[], interactive = false): string[] {
    const connection = this.databaseConnection();
    return [
      'run',
      '--rm',
      ...(interactive ? ['--interactive'] : []),
      '--network',
      this.networkName,
      '-e',
      'MYSQL_PWD',
      DATABASE_CLIENT_IMAGE,
      ...args,
      `--host=${connection.host}`,
      ...(connection.port === undefined ? [] : [`--port=${connection.port}`]),
      `--user=${connection.user}`,
      connection.database
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

  private databaseRunOptions(): RunOptions {
    return {
      env: {
        ...this.runOptions().env,
        MYSQL_PWD: this.requiredWordPressEnvironment('WORDPRESS_DB_PASSWORD')
      }
    };
  }

  private databaseConnection(): {
    host: string;
    port: string | undefined;
    user: string;
    database: string;
  } {
    const hostWithOptionalPort = this.requiredWordPressEnvironment('WORDPRESS_DB_HOST');
    const [host, port] = hostWithOptionalPort.split(':', 2);
    if (host === undefined || host.length === 0) {
      throw new Error('WORDPRESS_DB_HOST is required for database client helper');
    }

    return {
      host,
      port: port === undefined || port.length === 0 ? undefined : port,
      user: this.requiredWordPressEnvironment('WORDPRESS_DB_USER'),
      database: this.requiredWordPressEnvironment('WORDPRESS_DB_NAME')
    };
  }

  private requiredWordPressEnvironment(name: string): string {
    const value = this.wordpressEnvironment[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`${name} is required for database client helper`);
    }
    return value;
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
