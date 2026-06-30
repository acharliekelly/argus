import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessRunnerLike } from '../src/process.js';
import { discoverSite } from '../src/sites/discovery.js';

type ComposeRow = {
  ID: string;
  Image: string;
  Service: string;
  State: string;
  Publishers?: Array<{ TargetPort: number; PublishedPort: number; Protocol: string }>;
};

type InspectRow = {
  Id: string;
  Config: {
    Image: string;
    Env?: string[];
    Labels: Record<string, string>;
  };
  Mounts: Array<{ Type: string; Name?: string; Source: string; Destination: string }>;
  NetworkSettings: { Networks: Record<string, object> };
};

let directory: string;
let composeFile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'argus-discovery-'));
  composeFile = join(directory, 'compose.yml');
  await writeFile(composeFile, 'services: {}\n');
});

describe('discoverSite', () => {
  it('discovers one running WordPress service from array JSON and restricts its environment', async () => {
    const rows = [
      composeRow('0379de83ab5e', 'wordpress:7.0', 'wordpress', 'running', 8090),
      composeRow('31132589c269', 'mysql:5.7', 'db', 'running'),
      composeRow('c69149a4f1a3', 'alpine:3.22', 'fixture-installer', 'exited')
    ];
    rows[0]!.Publishers = [
      { TargetPort: 80, PublishedPort: 8090, Protocol: 'tcp' },
      { TargetPort: 80, PublishedPort: 8090, Protocol: 'tcp' }
    ];
    const inspections = [
      inspectRow('0379de83ab5e87a796edfa92bca00cb155d23fe70e3989cef73fc6b3a24aa111', {
        environment: [
          'WORDPRESS_DB_HOST=db:3306',
          'WORDPRESS_DB_NAME=wordpress',
          'WORDPRESS_DB_USER=wordpress',
          'WORDPRESS_DB_PASSWORD=secret',
          'WORDPRESS_TABLE_PREFIX=3Ge_',
          'WORDPRESS_DEBUG=1',
          'UNRELATED=value'
        ],
        networks: ['project_default', 'proxy'],
        mount: {
          Type: 'volume',
          Name: 'project_wordpress',
          Source: '/var/lib/docker/volumes/project_wordpress/_data',
          Destination: '/var/www/html'
        }
      }),
      inspectRow('31132589c269790a12e124386ba339622aac2f45de2e14b78e18cfb835e454ac', {
        image: 'mysql:5.7',
        service: 'db',
        mount: null,
        networks: ['project_default']
      })
    ];
    const runner = fakeRunner(JSON.stringify(rows), inspections);

    await expect(discoverSite({ composeFile }, runner)).resolves.toEqual({
      composeFile,
      projectDirectory: directory,
      projectName: 'project',
      wordpressService: 'wordpress',
      containerId: '0379de83ab5e87a796edfa92bca00cb155d23fe70e3989cef73fc6b3a24aa111',
      baseUrl: 'http://localhost:8090',
      networkName: 'project_default',
      wordpressMount: {
        type: 'volume',
        source: 'project_wordpress',
        destination: '/var/www/html'
      },
      wordpressEnvironment: {
        WORDPRESS_DB_HOST: 'db:3306',
        WORDPRESS_DB_NAME: 'wordpress',
        WORDPRESS_DB_USER: 'wordpress',
        WORDPRESS_DB_PASSWORD: 'secret',
        WORDPRESS_TABLE_PREFIX: '3Ge_'
      }
    });
    expect(runner.run).toHaveBeenNthCalledWith(1, 'docker', [
      'compose',
      '-f',
      composeFile,
      'ps',
      '--all',
      '--format',
      'json'
    ]);
    expect(runner.run).toHaveBeenNthCalledWith(2, 'docker', [
      'inspect',
      '0379de83ab5e',
      '31132589c269'
    ]);
  });

  it('parses newline-delimited Compose JSON and accepts a bind mount', async () => {
    const rows = [
      composeRow('wordpress-id', 'custom-app', 'web', 'running', 8080),
      composeRow('database-id', 'mysql:8', 'database', 'running')
    ];
    const runner = fakeRunner(
      rows.map((row) => JSON.stringify(row)).join('\n'),
      [
        inspectRow('wordpress-id', {
          environment: ['WORDPRESS_DB_HOST=database'],
          networks: ['demo_default'],
          mount: { Type: 'bind', Source: '/srv/site', Destination: '/var/www/html' },
          project: 'demo',
          service: 'web'
        }),
        inspectRow('database-id', {
          image: 'mysql:8',
          networks: ['demo_default'],
          project: 'demo',
          service: 'database'
        })
      ]
    );

    await expect(discoverSite({ composeFile }, runner)).resolves.toMatchObject({
      projectName: 'demo',
      wordpressService: 'web',
      baseUrl: 'http://localhost:8080',
      networkName: 'demo_default',
      wordpressMount: {
        type: 'bind',
        source: '/srv/site',
        destination: '/var/www/html'
      }
    });
  });

  it('honors WordPress service and base URL overrides', async () => {
    const rows = [
      composeRow('first-id', 'wordpress:latest', 'first', 'running', 8080),
      composeRow('second-id', 'wordpress:latest', 'second', 'running')
    ];
    const runner = fakeRunner(
      JSON.stringify(rows),
      [
        inspectRow('first-id', { service: 'first' }),
        inspectRow('second-id', { service: 'second' })
      ]
    );

    await expect(
      discoverSite(
        {
          composeFile,
          wordpressService: 'second',
          baseUrl: 'https://wordpress.test'
        },
        runner
      )
    ).resolves.toMatchObject({
      wordpressService: 'second',
      containerId: 'second-id',
      baseUrl: 'https://wordpress.test'
    });
  });

  it('rejects a missing Compose file before running Docker', async () => {
    const runner = fakeRunner('[]', []);

    await expect(
      discoverSite({ composeFile: join(directory, 'missing.yml') }, runner)
    ).rejects.toThrow(/^compose_file_missing:/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('reports ambiguous WordPress services', async () => {
    const rows = [
      composeRow('first-id', 'wordpress:latest', 'first', 'running', 8080),
      composeRow('second-id', 'wordpress:latest', 'second', 'running', 8081)
    ];
    const runner = fakeRunner(
      JSON.stringify(rows),
      [
        inspectRow('first-id', { service: 'first' }),
        inspectRow('second-id', { service: 'second' })
      ]
    );

    await expect(discoverSite({ composeFile }, runner)).rejects.toThrow(
      /^wordpress_service_ambiguous:.*first.*second.*--wordpress-service/
    );
  });

  it('reports a requested stopped WordPress service without inspecting it', async () => {
    const rows = [composeRow('wordpress-id', 'wordpress:latest', 'wordpress', 'exited', 8090)];
    const runner = fakeRunner(JSON.stringify(rows), []);

    await expect(
      discoverSite({ composeFile, wordpressService: 'wordpress' }, runner)
    ).rejects.toThrow(/^wordpress_service_not_running:.*--wordpress-service/);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('reports an auto-detected stopped WordPress candidate as not running', async () => {
    const rows = [
      composeRow('wordpress-id', 'wordpress:latest', 'wordpress', 'exited', 8090),
      composeRow('database-id', 'mysql:8', 'db', 'running')
    ];
    const runner = fakeRunner(
      JSON.stringify(rows),
      [inspectRow('database-id', { image: 'mysql:8', service: 'db', mount: null })]
    );

    await expect(discoverSite({ composeFile }, runner)).rejects.toThrow(
      /^wordpress_service_not_running:.*wordpress.*--wordpress-service/
    );
    expect(runner.run).toHaveBeenNthCalledWith(2, 'docker', ['inspect', 'database-id']);
  });

  it('reports a running selected service that does not signal WordPress as not found', async () => {
    const rows = [composeRow('database-id', 'mysql:8', 'db', 'running')];
    const runner = fakeRunner(
      JSON.stringify(rows),
      [inspectRow('database-id', { image: 'mysql:8', service: 'db', mount: null })]
    );

    await expect(
      discoverSite({ composeFile, wordpressService: 'db' }, runner)
    ).rejects.toThrow(/^wordpress_service_not_found:.*db.*--wordpress-service/);
  });

  it('reports when no running service looks like WordPress', async () => {
    const rows = [composeRow('database-id', 'mariadb:11', 'db', 'running')];
    const runner = fakeRunner(
      JSON.stringify(rows),
      [inspectRow('database-id', { image: 'mariadb:11', service: 'db', mount: null })]
    );

    await expect(discoverSite({ composeFile }, runner)).rejects.toThrow(
      /^wordpress_service_not_found:.*--wordpress-service/
    );
  });

  it('requires a unique published host port for container port 80', async () => {
    const row = composeRow('wordpress-id', 'wordpress:latest', 'wordpress', 'running');
    row.Publishers = [
      { TargetPort: 80, PublishedPort: 8090, Protocol: 'tcp' },
      { TargetPort: 80, PublishedPort: 8091, Protocol: 'tcp' }
    ];
    const runner = fakeRunner(JSON.stringify([row]), [inspectRow('wordpress-id')]);

    await expect(discoverSite({ composeFile }, runner)).rejects.toThrow(
      /^base_url_ambiguous:.*--url/
    );
  });

  it('rejects unsupported WordPress mount types', async () => {
    const rows = [composeRow('wordpress-id', 'wordpress:latest', 'wordpress', 'running', 8090)];
    const runner = fakeRunner(
      JSON.stringify(rows),
      [
        inspectRow('wordpress-id', {
          mount: { Type: 'tmpfs', Source: '', Destination: '/var/www/html' }
        })
      ]
    );

    await expect(discoverSite({ composeFile }, runner)).rejects.toThrow(
      /^unsupported_wordpress_mount:/
    );
  });

  it('requires a unique Compose network when the database host cannot disambiguate it', async () => {
    const rows = [composeRow('wordpress-id', 'wordpress:latest', 'wordpress', 'running', 8090)];
    const runner = fakeRunner(
      JSON.stringify(rows),
      [inspectRow('wordpress-id', { networks: ['project_default', 'project_internal'] })]
    );

    await expect(discoverSite({ composeFile }, runner)).rejects.toThrow(
      /^compose_network_ambiguous:/
    );
  });

  it('prefers the network shared with the configured database service', async () => {
    const rows = [
      composeRow('wordpress-id', 'wordpress:latest', 'wordpress', 'running', 8090),
      composeRow('database-id', 'mariadb:11', 'db', 'running')
    ];
    const runner = fakeRunner(
      JSON.stringify(rows),
      [
        inspectRow('wordpress-id', {
          environment: ['WORDPRESS_DB_HOST=db:3306'],
          networks: ['project_default', 'project_internal']
        }),
        inspectRow('database-id', {
          image: 'mariadb:11',
          service: 'db',
          mount: null,
          networks: ['project_internal']
        })
      ]
    );

    await expect(discoverSite({ composeFile }, runner)).resolves.toMatchObject({
      networkName: 'project_internal'
    });
  });
});

function composeRow(
  ID: string,
  Image: string,
  Service: string,
  State: string,
  publishedPort?: number
): ComposeRow {
  return {
    ID,
    Image,
    Service,
    State,
    ...(publishedPort
      ? {
          Publishers: [{ TargetPort: 80, PublishedPort: publishedPort, Protocol: 'tcp' }]
        }
      : {})
  };
}

function inspectRow(
  Id: string,
  options: {
    image?: string;
    environment?: string[];
    networks?: string[];
    mount?: { Type: string; Name?: string; Source: string; Destination: string } | null;
    project?: string;
    service?: string;
  } = {}
): InspectRow {
  const service = options.service ?? 'wordpress';
  return {
    Id,
    Config: {
      Image: options.image ?? 'wordpress:latest',
      Env: options.environment ?? [],
      Labels: {
        'com.docker.compose.project': options.project ?? 'project',
        'com.docker.compose.service': service
      }
    },
    Mounts:
      options.mount === null
        ? []
        : [
            options.mount ?? {
              Type: 'volume',
              Name: 'project_wordpress',
              Source: '/var/lib/docker/volumes/project_wordpress/_data',
              Destination: '/var/www/html'
            }
          ],
    NetworkSettings: {
      Networks: Object.fromEntries((options.networks ?? ['project_default']).map((name) => [name, {}]))
    }
  };
}

function fakeRunner(composeOutput: string, inspections: InspectRow[]): ProcessRunnerLike & {
  run: ReturnType<typeof vi.fn<ProcessRunnerLike['run']>>;
  runBuffer: ReturnType<typeof vi.fn<ProcessRunnerLike['runBuffer']>>;
} {
  const run = vi.fn<ProcessRunnerLike['run']>(async (_command, args) => {
    const stdout = args[0] === 'compose' ? composeOutput : JSON.stringify(inspections);
    return {
      command: 'docker',
      args,
      stdout,
      stderr: '',
      exitCode: 0,
      durationMs: 1
    };
  });
  const runBuffer = vi.fn<ProcessRunnerLike['runBuffer']>();
  return { run, runBuffer };
}
