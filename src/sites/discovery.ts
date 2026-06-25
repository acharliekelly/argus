import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  ProcessRunner,
  assertCommandPassed,
  type ProcessRunnerLike
} from '../process.js';

const WORDPRESS_ROOT = '/var/www/html' as const;
const WORDPRESS_ENVIRONMENT_KEYS = [
  'WORDPRESS_DB_HOST',
  'WORDPRESS_DB_NAME',
  'WORDPRESS_DB_USER',
  'WORDPRESS_DB_PASSWORD'
] as const;

export type DiscoverSiteInput = {
  composeFile: string;
  wordpressService?: string;
  baseUrl?: string;
};

export type DiscoveredSite = {
  composeFile: string;
  projectDirectory: string;
  projectName: string;
  wordpressService: string;
  containerId: string;
  baseUrl: string;
  networkName: string;
  wordpressMount: {
    type: 'bind' | 'volume';
    source: string;
    destination: typeof WORDPRESS_ROOT;
  };
  wordpressEnvironment: Record<string, string>;
};

type ComposeContainer = {
  id: string;
  image: string;
  service: string;
  state: string;
  publishers: Array<{
    targetPort: number;
    publishedPort: number;
  }>;
};

type InspectedContainer = {
  id: string;
  image: string;
  environment: Record<string, string>;
  labels: Record<string, string>;
  mounts: Array<{
    type: string;
    source: string;
    destination: string;
  }>;
  networks: string[];
};

type Candidate = {
  compose: ComposeContainer;
  inspect: InspectedContainer;
};

export async function discoverSite(
  input: DiscoverSiteInput,
  runner: ProcessRunnerLike = new ProcessRunner()
): Promise<DiscoveredSite> {
  const composeFile = resolve(input.composeFile);
  try {
    await access(composeFile);
  } catch {
    fail('compose_file_missing', `Compose file does not exist: ${composeFile}`);
  }

  const composeResult = assertCommandPassed(
    await runner.run('docker', ['compose', '-f', composeFile, 'ps', '--format', 'json']),
    'compose_ps'
  );
  const composeContainers = parseComposeOutput(composeResult.stdout);
  const containerIds = composeContainers.map((container) => container.id).filter(Boolean);
  const inspectedContainers =
    containerIds.length === 0
      ? []
      : parseInspectOutput(
          assertCommandPassed(
            await runner.run('docker', ['inspect', ...containerIds]),
            'docker_inspect'
          ).stdout
        );
  const inspections = new Map(
    inspectedContainers.map((container) => [container.id, container])
  );
  const containers = composeContainers
    .map((compose): Candidate | null => {
      const inspect = inspections.get(compose.id);
      if (!inspect) {
        return null;
      }
      return { compose, inspect };
    })
    .filter((candidate): candidate is Candidate => candidate !== null);
  const candidates = containers.filter(({ compose, inspect }) =>
    signalsWordPress(compose, inspect)
  );

  const selected = selectCandidate(candidates, input.wordpressService);
  const projectName = requiredLabel(
    selected.inspect,
    'com.docker.compose.project',
    'compose_project_missing'
  );
  const wordpressService = requiredLabel(
    selected.inspect,
    'com.docker.compose.service',
    'compose_service_missing'
  );

  return {
    composeFile,
    projectDirectory: dirname(composeFile),
    projectName,
    wordpressService,
    containerId: selected.inspect.id,
    baseUrl: input.baseUrl ?? discoverBaseUrl(selected.compose),
    networkName: discoverNetwork(selected, containers, projectName),
    wordpressMount: discoverWordPressMount(selected.inspect),
    wordpressEnvironment: restrictWordPressEnvironment(selected.inspect.environment)
  };
}

function parseComposeOutput(output: string): ComposeContainer[] {
  if (output.trim() === '') {
    return [];
  }

  const parsed = parseArrayOrNdjson(output, 'compose_ps_invalid_json');
  return parsed.map((value) => {
    const row = asRecord(value, 'compose_ps_invalid_json');
    const publishers = Array.isArray(row.Publishers) ? row.Publishers : [];
    return {
      id: stringField(row, 'ID'),
      image: stringField(row, 'Image'),
      service: stringField(row, 'Service'),
      state: stringField(row, 'State'),
      publishers: publishers.flatMap((publisher) => {
        const item = asRecord(publisher, 'compose_ps_invalid_json');
        const targetPort = numberField(item, 'TargetPort');
        const publishedPort = numberField(item, 'PublishedPort');
        return targetPort === undefined || publishedPort === undefined
          ? []
          : [{ targetPort, publishedPort }];
      })
    };
  });
}

function parseInspectOutput(output: string): InspectedContainer[] {
  const parsed = parseArrayOrNdjson(output, 'docker_inspect_invalid_json');
  return parsed.map((value) => {
    const row = asRecord(value, 'docker_inspect_invalid_json');
    const config = asRecord(row.Config, 'docker_inspect_invalid_json');
    const networkSettings = asRecord(row.NetworkSettings, 'docker_inspect_invalid_json');
    const networks = asRecord(networkSettings.Networks, 'docker_inspect_invalid_json');
    const labels =
      config.Labels === null || config.Labels === undefined
        ? {}
        : stringRecord(config.Labels, 'docker_inspect_invalid_json');
    const environment = Array.isArray(config.Env)
      ? parseEnvironment(config.Env)
      : {};
    const mounts = Array.isArray(row.Mounts) ? row.Mounts : [];

    return {
      id: stringField(row, 'Id'),
      image: stringField(config, 'Image'),
      environment,
      labels,
      mounts: mounts.map((mount) => {
        const item = asRecord(mount, 'docker_inspect_invalid_json');
        return {
          type: stringField(item, 'Type'),
          source: stringField(item, 'Source'),
          destination: stringField(item, 'Destination')
        };
      }),
      networks: Object.keys(networks)
    };
  });
}

function parseArrayOrNdjson(output: string, reasonCode: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      return output
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line): unknown => JSON.parse(line));
    } catch {
      fail(reasonCode, 'Docker returned malformed JSON');
    }
  }
}

function parseEnvironment(values: unknown[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const separator = value.indexOf('=');
    if (separator < 0) {
      environment[value] = '';
    } else {
      environment[value.slice(0, separator)] = value.slice(separator + 1);
    }
  }
  return environment;
}

function signalsWordPress(
  compose: ComposeContainer,
  inspect: InspectedContainer
): boolean {
  const imageSignalsWordPress = /(?:^|[/_-])wordpress(?=[:@/_-]|$)/i.test(
    `${compose.image} ${inspect.image}`
  );
  const environmentSignalsWordPress = Object.keys(inspect.environment).some((key) =>
    key.startsWith('WORDPRESS_')
  );
  const hasWordPressMount = inspect.mounts.some(
    (mount) => mount.destination === WORDPRESS_ROOT
  );
  return (imageSignalsWordPress || environmentSignalsWordPress) && hasWordPressMount;
}

function selectCandidate(
  candidates: Candidate[],
  wordpressService: string | undefined
): Candidate {
  const matchingService =
    wordpressService === undefined
      ? candidates
      : candidates.filter(
          (candidate) =>
            candidate.compose.service === wordpressService ||
            candidate.inspect.labels['com.docker.compose.service'] === wordpressService
        );
  const running = matchingService.filter(
    (candidate) => candidate.compose.state.toLowerCase() === 'running'
  );

  if (running.length === 1) {
    return running[0] as Candidate;
  }
  if (running.length > 1) {
    const services = running.map(candidateService).sort().join(', ');
    fail(
      'wordpress_service_ambiguous',
      `Multiple running WordPress services matched: ${services}; provide wordpressService`
    );
  }
  if (wordpressService !== undefined || matchingService.length > 0) {
    fail(
      'wordpress_service_not_running',
      `WordPress service ${wordpressService ?? candidateService(matchingService[0] as Candidate)} is not running`
    );
  }
  fail(
    'wordpress_service_not_found',
    'No running Compose service has a WordPress image or environment and a /var/www/html mount'
  );
}

function discoverBaseUrl(container: ComposeContainer): string {
  const ports = [
    ...new Set(
      container.publishers
        .filter((publisher) => publisher.targetPort === 80)
        .map((publisher) => publisher.publishedPort)
    )
  ];
  if (ports.length !== 1) {
    fail(
      'base_url_ambiguous',
      'Expected one published host port for container port 80; provide baseUrl'
    );
  }
  return `http://localhost:${String(ports[0])}`;
}

function discoverWordPressMount(
  container: InspectedContainer
): DiscoveredSite['wordpressMount'] {
  const mounts = container.mounts.filter((mount) => mount.destination === WORDPRESS_ROOT);
  const mount = mounts[0];
  if (
    mounts.length !== 1 ||
    !mount ||
    (mount.type !== 'bind' && mount.type !== 'volume')
  ) {
    fail(
      'unsupported_wordpress_mount',
      'The /var/www/html mount must be one bind mount or named volume'
    );
  }
  return {
    type: mount.type,
    source: mount.source,
    destination: WORDPRESS_ROOT
  };
}

function discoverNetwork(
  wordpress: Candidate,
  containers: Candidate[],
  projectName: string
): string {
  const databaseHost = wordpress.inspect.environment.WORDPRESS_DB_HOST?.split(':')[0];
  const database = databaseHost
    ? containers.find(
        (candidate) =>
          candidate !== wordpress &&
          (candidate.compose.service === databaseHost ||
            candidate.inspect.labels['com.docker.compose.service'] === databaseHost)
      )
    : undefined;
  if (database) {
    const shared = wordpress.inspect.networks.filter((network) =>
      database.inspect.networks.includes(network)
    );
    if (shared.length === 1) {
      return shared[0] as string;
    }
  }

  const composeNetworks = wordpress.inspect.networks.filter(
    (network) => network === projectName || network.startsWith(`${projectName}_`)
  );
  const availableNetworks =
    composeNetworks.length > 0 ? composeNetworks : wordpress.inspect.networks;
  if (availableNetworks.length !== 1) {
    fail(
      'compose_network_ambiguous',
      `Expected one Compose network for ${candidateService(wordpress)}; found ${availableNetworks.join(', ') || 'none'}`
    );
  }
  return availableNetworks[0] as string;
}

function restrictWordPressEnvironment(
  environment: Record<string, string>
): Record<string, string> {
  const restricted: Record<string, string> = {};
  for (const key of WORDPRESS_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      restricted[key] = value;
    }
  }
  return restricted;
}

function candidateService(candidate: Candidate): string {
  return candidate.inspect.labels['com.docker.compose.service'] ?? candidate.compose.service;
}

function requiredLabel(
  container: InspectedContainer,
  label: string,
  reasonCode: string
): string {
  const value = container.labels[label];
  if (!value) {
    fail(reasonCode, `Container ${container.id} is missing label ${label}`);
  }
  return value;
}

function asRecord(value: unknown, reasonCode: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(reasonCode, 'Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown, reasonCode: string): Record<string, string> {
  const record = asRecord(value, reasonCode);
  for (const item of Object.values(record)) {
    if (typeof item !== 'string') {
      fail(reasonCode, 'Expected string values');
    }
  }
  return record as Record<string, string>;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === 'string' ? value : '';
}

function numberField(
  record: Record<string, unknown>,
  field: string
): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
}

function fail(reasonCode: string, message: string): never {
  throw new Error(`${reasonCode}: ${message}`);
}
