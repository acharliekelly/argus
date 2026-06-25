import { assertCommandPassed, type ProcessRunnerLike } from '../process.js';
import type { CommandRecord, SiteInventory, UpdateTarget } from '../types.js';
import {
  normalizeCoreInventory,
  normalizeExtensionInventory
} from './inventory.js';

type ComposeSettings = {
  file: string;
  wpCliService: string;
  wordpressService: string;
  profiles?: string[];
};

export type PreflightCheck = {
  name: string;
  passed: boolean;
  message: string;
};

export class WordPressAdapter {
  constructor(
    private readonly runner: ProcessRunnerLike,
    private readonly compose: ComposeSettings
  ) {}

  private composeArgs(...args: string[]): string[] {
    const profiles = (this.compose.profiles ?? []).flatMap((profile) => [
      '--profile',
      profile
    ]);
    return ['compose', '-f', this.compose.file, ...profiles, ...args];
  }

  async composeRun(args: string[]): Promise<CommandRecord> {
    return this.runner.run('docker', this.composeArgs(...args));
  }

  async wp(args: string[]): Promise<CommandRecord> {
    return this.composeRun([
      'run',
      '--rm',
      '--no-deps',
      this.compose.wpCliService,
      'wp',
      ...args,
      '--allow-root'
    ]);
  }

  async preflight(): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    const docker = await this.runner.run('docker', ['version', '--format', '{{.Server.Version}}']);
    checks.push({
      name: 'docker',
      passed: docker.exitCode === 0,
      message: docker.exitCode === 0 ? `Docker ${docker.stdout}` : docker.stderr
    });
    if (docker.exitCode !== 0) {
      return checks;
    }

    const services = await this.composeRun(['config', '--services']);
    const serviceNames = services.stdout.split(/\s+/).filter(Boolean);
    const requiredServices = [this.compose.wordpressService, this.compose.wpCliService];
    const servicesPassed =
      services.exitCode === 0 && requiredServices.every((service) => serviceNames.includes(service));
    checks.push({
      name: 'compose_services',
      passed: servicesPassed,
      message: servicesPassed
        ? `Found ${requiredServices.join(', ')}`
        : `Missing required services: ${requiredServices
            .filter((service) => !serviceNames.includes(service))
            .join(', ')}`
    });
    if (!servicesPassed) {
      return checks;
    }

    const wordpress = await this.wp(['core', 'is-installed']);
    checks.push({
      name: 'wordpress',
      passed: wordpress.exitCode === 0,
      message: wordpress.exitCode === 0 ? 'WordPress is installed' : wordpress.stderr
    });
    return checks;
  }

  async inventory(): Promise<SiteInventory> {
    const coreVersion = assertCommandPassed(
      await this.wp(['core', 'version']),
      'Read WordPress core version'
    );
    const coreUpdates = assertCommandPassed(
      await this.wp(['core', 'check-update', '--format=json']),
      'Read WordPress core updates'
    );
    const plugins = assertCommandPassed(
      await this.wp(['plugin', 'list', '--format=json']),
      'Read plugin inventory'
    );
    const themes = assertCommandPassed(
      await this.wp(['theme', 'list', '--format=json']),
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
      throw new Error('unsupported_target: WordPress core is managed by the Compose image');
    }
    return this.wp([target.type, 'update', target.slug]);
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
