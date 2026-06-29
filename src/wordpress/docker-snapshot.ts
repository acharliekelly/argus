import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import type { BinaryCommandResult } from '../process.js';
import { assertCommandPassed } from '../process.js';
import type { RunStore } from '../run-store.js';
import type { CommandRecord } from '../types.js';
import type { SnapshotMetadata } from './snapshot.js';

type SnapshotHelper = {
  runWp(args: string[], input?: Buffer): Promise<CommandRecord>;
  runUtility(args: string[], input?: Buffer): Promise<CommandRecord>;
  runUtilityBuffer(args: string[]): Promise<BinaryCommandResult>;
};

const DATABASE_SNAPSHOT_PATH = 'snapshot/database.sql' as const;
const CONTENT_SNAPSHOT_PATH = 'snapshot/wp-content.tar.gz' as const;

export class DockerSnapshotService {
  constructor(
    private readonly helper: SnapshotHelper,
    private readonly store: RunStore
  ) {}

  async create(runId: string): Promise<SnapshotMetadata> {
    const databasePath = this.store.runPath(runId, DATABASE_SNAPSHOT_PATH);
    const contentPath = this.store.runPath(runId, CONTENT_SNAPSHOT_PATH);
    await mkdir(dirname(databasePath), { recursive: true });

    const database = assertCommandPassed(
      await this.helper.runWp(['db', 'export', '-', '--skip-ssl']),
      'Export WordPress database'
    );
    await writeAtomic(databasePath, database.stdout);

    const content = await this.helper.runUtilityBuffer([
      'tar',
      '-czf',
      '-',
      '-C',
      '/var/www/html',
      'wp-content'
    ]);
    assertBinaryCommandPassed(content, 'Archive WordPress content');
    await writeAtomic(contentPath, content.stdout);

    return {
      databasePath: relative(this.store.runPath(runId), databasePath),
      contentPath: relative(this.store.runPath(runId), contentPath),
      createdAt: new Date().toISOString()
    };
  }

  async restore(runId: string, metadata: SnapshotMetadata): Promise<void> {
    const databasePath = this.store.runPath(runId, metadata.databasePath);
    const contentPath = this.store.runPath(runId, metadata.contentPath);
    const archive = await readFile(contentPath);

    assertCommandPassed(
      await this.helper.runUtility(
        ['sh', '-lc', 'rm -rf /var/www/html/wp-content && tar -xzf - -C /var/www/html'],
        archive
      ),
      'Restore WordPress content'
    );

    assertCommandPassed(
      await this.helper.runWp(['db', 'import', '-', '--skip-ssl'], await readFile(databasePath)),
      'Restore WordPress database'
    );
  }
}

async function writeAtomic(path: string, value: string | Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

function assertBinaryCommandPassed(
  result: BinaryCommandResult,
  context: string
): BinaryCommandResult {
  if (result.exitCode !== 0) {
    throw new Error(
      `${context} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout.toString('utf8')}`
    );
  }
  return result;
}
