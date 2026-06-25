import { mkdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { assertCommandPassed, type ProcessRunnerLike } from '../process.js';

export type SnapshotMetadata = {
  databasePath: string;
  contentPath: string;
  createdAt: string;
};

type SnapshotSettings = {
  composeFile: string;
  wpCliService: string;
  wordpressService: string;
  artifactRoot: string;
  profiles?: string[];
};

export class SnapshotService {
  private readonly artifactRoot: string;

  constructor(
    private readonly runner: ProcessRunnerLike,
    private readonly settings: SnapshotSettings
  ) {
    this.artifactRoot = resolve(settings.artifactRoot);
  }

  private composeArgs(...args: string[]): string[] {
    const profiles = (this.settings.profiles ?? []).flatMap((profile) => [
      '--profile',
      profile
    ]);
    return ['compose', '-f', this.settings.composeFile, ...profiles, ...args];
  }

  private containerPath(hostPath: string): string {
    return `/argus/${relative(this.artifactRoot, hostPath).replaceAll('\\', '/')}`;
  }

  async create(runId: string): Promise<SnapshotMetadata> {
    const snapshotDirectory = join(this.artifactRoot, 'runs', runId, 'snapshot');
    await mkdir(snapshotDirectory, { recursive: true });
    const databasePath = join(snapshotDirectory, 'database.sql');
    const contentPath = join(snapshotDirectory, 'wp-content.tar.gz');
    const containerDatabasePath = this.containerPath(databasePath);
    const containerContentPath = this.containerPath(contentPath);

    const database = await this.runner.run(
      'docker',
      this.composeArgs(
        'run',
        '--rm',
        '--no-deps',
        this.settings.wpCliService,
        'wp',
        'db',
        'export',
        containerDatabasePath,
        '--skip-ssl',
        '--allow-root'
      )
    );
    assertCommandPassed(database, 'Export WordPress database');

    const content = await this.runner.run(
      'docker',
      this.composeArgs(
        'exec',
        '-T',
        this.settings.wordpressService,
        'tar',
        '-czf',
        containerContentPath,
        '-C',
        '/var/www/html',
        'wp-content'
      )
    );
    assertCommandPassed(content, 'Archive WordPress content');

    return {
      databasePath: relative(join(this.artifactRoot, 'runs', runId), databasePath),
      contentPath: relative(join(this.artifactRoot, 'runs', runId), contentPath),
      createdAt: new Date().toISOString()
    };
  }

  async restore(runId: string, metadata: SnapshotMetadata): Promise<void> {
    const runDirectory = join(this.artifactRoot, 'runs', runId);
    const hostDatabasePath = join(runDirectory, metadata.databasePath);
    const contentPath = this.containerPath(join(runDirectory, metadata.contentPath));

    const content = await this.runner.run(
      'docker',
      this.composeArgs(
        'exec',
        '-T',
        this.settings.wordpressService,
        'sh',
        '-lc',
        `rm -rf /var/www/html/wp-content && tar -xzf '${contentPath}' -C /var/www/html`
      )
    );
    assertCommandPassed(content, 'Restore WordPress content');

    const [databaseHost, databaseUser, databasePassword, databaseName] =
      await Promise.all([
        this.readWordPressConfig('DB_HOST'),
        this.readWordPressConfig('DB_USER'),
        this.readWordPressConfig('DB_PASSWORD'),
        this.readWordPressConfig('DB_NAME')
      ]);
    const { host, port } = parseDatabaseHost(databaseHost);
    const database = await this.runner.run(
      'docker',
      this.composeArgs(
        'run',
        '--rm',
        '--no-deps',
        '-e',
        'MYSQL_PWD',
        this.settings.wpCliService,
        'mariadb',
        '--skip-ssl',
        `--host=${host}`,
        ...(port ? [`--port=${port}`] : []),
        `--user=${databaseUser}`,
        databaseName
      ),
      {
        env: { ...process.env, MYSQL_PWD: databasePassword },
        input: await readFile(hostDatabasePath)
      }
    );
    assertCommandPassed(database, 'Restore WordPress database');
  }

  private async readWordPressConfig(name: string): Promise<string> {
    const result = await this.runner.run(
      'docker',
      this.composeArgs(
        'run',
        '--rm',
        '--no-deps',
        this.settings.wpCliService,
        'wp',
        'config',
        'get',
        name,
        '--allow-root'
      )
    );
    return assertCommandPassed(result, `Read WordPress ${name}`).stdout.trim();
  }
}

function parseDatabaseHost(value: string): { host: string; port: string | null } {
  const match = /^(.*):(\d+)$/.exec(value);
  if (!match) {
    return { host: value, port: null };
  }
  return { host: match[1] ?? value, port: match[2] ?? null };
}
