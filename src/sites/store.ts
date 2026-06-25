import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveSitePaths } from './paths.js';
import { siteProfileSchema, type SiteProfile } from './profile.js';

export class SiteStore {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async save(input: unknown, force = false): Promise<SiteProfile> {
    const profile = siteProfileSchema.parse(input);
    const paths = resolveSitePaths(profile.name, this.environment);

    await mkdir(dirname(paths.profilePath), { recursive: true });
    await mkdir(paths.dataRoot, { recursive: true });

    const temporaryPath = `${paths.profilePath}.${process.pid}.${randomUUID()}.tmp`;
    let temporaryHandle;
    try {
      temporaryHandle = await open(temporaryPath, 'wx');
      await temporaryHandle.writeFile(`${JSON.stringify(profile, null, 2)}\n`, 'utf8');
      await temporaryHandle.close();
      temporaryHandle = undefined;

      if (force) {
        await rename(temporaryPath, paths.profilePath);
      } else {
        try {
          await link(temporaryPath, paths.profilePath);
        } catch (error) {
          if (isErrorCode(error, 'EEXIST')) {
            throw new Error(`Site profile already exists: ${profile.name}`);
          }
          throw error;
        }
      }
    } finally {
      await temporaryHandle?.close();
      await rm(temporaryPath, { force: true });
    }

    return profile;
  }

  async load(name: string): Promise<SiteProfile> {
    const { profilePath } = resolveSitePaths(name, this.environment);
    const input: unknown = JSON.parse(await readFile(profilePath, 'utf8'));
    return siteProfileSchema.parse(input);
  }

  async list(): Promise<string[]> {
    const { profilePath } = resolveSitePaths('profile', this.environment);
    const profileDirectory = dirname(profilePath);

    let entries;
    try {
      entries = await readdir(profileDirectory, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        return [];
      }
      throw error;
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .filter((name) => {
        try {
          resolveSitePaths(name, this.environment);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  }

  async disconnect(name: string): Promise<void> {
    const { profilePath } = resolveSitePaths(name, this.environment);
    await rm(profilePath, { force: true });
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
