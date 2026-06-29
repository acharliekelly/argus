import { assertCommandPassed } from '../process.js';
import type { CommandRecord, SiteInventory, UpdateTarget } from '../types.js';
import {
  normalizeCoreInventory,
  normalizeExtensionInventory
} from './inventory.js';
import type { PreflightCheck } from './adapter.js';

type WordPressHelper = {
  runWp(args: string[]): Promise<CommandRecord>;
  runUtility(args: string[], input?: Buffer): Promise<CommandRecord>;
};

export class DockerWordPressAdapter {
  constructor(private readonly helper: WordPressHelper) {}

  async preflight(): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    let docker: CommandRecord;
    try {
      docker = await this.helper.runUtility(['true']);
    } catch (error) {
      checks.push({
        name: 'docker',
        passed: false,
        message: error instanceof Error ? error.message : String(error)
      });
      return checks;
    }
    checks.push({
      name: 'docker',
      passed: docker.exitCode === 0,
      message:
        docker.exitCode === 0
          ? 'Docker helper container is reachable'
          : docker.stderr || docker.stdout
    });
    if (docker.exitCode !== 0) {
      return checks;
    }

    let wordpress: CommandRecord;
    try {
      wordpress = await this.helper.runWp(['core', 'is-installed']);
    } catch (error) {
      checks.push({
        name: 'wordpress',
        passed: false,
        message: error instanceof Error ? error.message : String(error)
      });
      return checks;
    }
    checks.push({
      name: 'wordpress',
      passed: wordpress.exitCode === 0,
      message: wordpress.exitCode === 0 ? 'WordPress is installed' : wordpress.stderr || wordpress.stdout
    });
    return checks;
  }

  async inventory(): Promise<SiteInventory> {
    const coreVersion = assertCommandPassed(
      await this.helper.runWp(['core', 'version']),
      'Read WordPress core version'
    );
    const coreUpdates = assertCommandPassed(
      await this.helper.runWp(['core', 'check-update', '--format=json']),
      'Read WordPress core updates'
    );
    const plugins = assertCommandPassed(
      await this.helper.runWp(['plugin', 'list', '--format=json']),
      'Read plugin inventory'
    );
    const themes = assertCommandPassed(
      await this.helper.runWp(['theme', 'list', '--format=json']),
      'Read theme inventory'
    );

    return {
      core: normalizeCoreInventory(
        coreVersion.stdout.trim(),
        parseJsonArray(coreUpdates.stdout)
      ),
      plugins: normalizeExtensionInventory(parseJsonArray(plugins.stdout)),
      themes: normalizeExtensionInventory(parseJsonArray(themes.stdout))
    };
  }

  async update(target: UpdateTarget): Promise<CommandRecord> {
    if (target.type === 'core') {
      throw new Error('unsupported_target: WordPress core is managed by the named-site helper');
    }
    return this.helper.runWp([target.type, 'update', target.slug]);
  }
}

function parseJsonArray<T>(value: string): T[] {
  if (!value.trim()) {
    return [];
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error('WP-CLI returned a non-array JSON value');
  }
  return parsed as T[];
}
