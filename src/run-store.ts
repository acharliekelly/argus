import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export class RunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  runPath(runId: string, ...parts: string[]): string {
    const runsRoot = resolve(this.root, 'runs');
    const runRoot = resolve(runsRoot, runId);
    assertWithin(runsRoot, runRoot, 'Run ID resolves outside runs directory');
    const target = resolve(runRoot, ...parts);
    assertWithin(runRoot, target, 'Path resolves outside run directory');
    return target;
  }

  async createRun(runId: string): Promise<string> {
    const path = this.runPath(runId);
    await mkdir(dirname(path), { recursive: true });
    await mkdir(path, { recursive: false });
    return path;
  }

  async ensureRunDirectory(runId: string, path: string): Promise<string> {
    const absolutePath = this.runPath(runId, path);
    await mkdir(absolutePath, { recursive: true });
    return absolutePath;
  }

  async writeJson(runId: string, path: string, value: unknown): Promise<void> {
    const target = this.runPath(runId, path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  }

  async readJson<T>(runId: string, path: string): Promise<T> {
    return JSON.parse(await readFile(this.runPath(runId, path), 'utf8')) as T;
  }
}

function assertWithin(parent: string, candidate: string, message: string): void {
  if (candidate !== parent && !candidate.startsWith(`${parent}${sep}`)) {
    throw new Error(message);
  }
}

type LockData = {
  pid: number;
  runId: string;
  acquiredAt: string;
};

export class RunLock {
  readonly lockPath: string;

  constructor(
    root: string,
    private readonly isProcessAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  ) {
    this.lockPath = join(resolve(root), 'lock.json');
  }

  async acquire(runId: string): Promise<void> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    try {
      const handle = await open(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      const lock: LockData = { pid: process.pid, runId, acquiredAt: new Date().toISOString() };
      await handle.writeFile(`${JSON.stringify(lock)}\n`);
      await handle.close();
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }
    }

    const current = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockData;
    if (this.isProcessAlive(current.pid)) {
      throw new Error(`A maintenance run is active: ${current.runId} (PID ${current.pid})`);
    }

    await rm(this.lockPath, { force: true });
    await this.acquire(runId);
  }

  async release(): Promise<void> {
    await rm(this.lockPath, { force: true });
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }
}
