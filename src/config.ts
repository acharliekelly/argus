import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import { z } from 'zod';
import type { ScenarioDefinition, ViewportDefinition } from './types.js';

const scenarioSchema = z.object({
  name: z.string().min(1),
  path: z.string().startsWith('/'),
  visualThreshold: z.number().min(0).max(1).optional(),
  mask: z.array(z.string().min(1)).default([]),
  run: z.function().optional()
});

const inputSchema = z.object({
  baseUrl: z.string().url(),
  artifactDir: z.string().default('.argus'),
  compose: z.object({
    file: z.string().default('docker-compose.yml'),
    wordpressService: z.string().min(1),
    wpCliService: z.string().min(1),
    profiles: z.array(z.string().min(1)).default([])
  }),
  visualThreshold: z.number().min(0).max(1).default(0.01),
  scenarios: z.array(scenarioSchema).min(1),
  viewports: z
    .array(
      z.object({
        name: z.string().min(1),
        width: z.number().int().positive(),
        height: z.number().int().positive()
      })
    )
    .min(1),
  secrets: z.record(z.string(), z.string().min(1)).default({})
});

export type ArgusConfigInput = z.input<typeof inputSchema> & {
  scenarios: ScenarioDefinition[];
  viewports: ViewportDefinition[];
};

export type ResolvedArgusConfig = Omit<z.output<typeof inputSchema>, 'secrets' | 'scenarios'> & {
  scenarios: ScenarioDefinition[];
  secrets: Record<string, string>;
  secretValues: string[];
};

export function defineConfig(config: ArgusConfigInput): ArgusConfigInput {
  return config;
}

function assertUniqueNames(items: Array<{ name: string }>, label: string): void {
  const names = new Set<string>();
  for (const item of items) {
    if (names.has(item.name)) {
      throw new Error(`Duplicate ${label} name: ${item.name}`);
    }
    names.add(item.name);
  }
}

export function resolveConfig(
  input: ArgusConfigInput,
  environment: NodeJS.ProcessEnv = process.env
): ResolvedArgusConfig {
  const parsed = inputSchema.parse(input);
  assertUniqueNames(parsed.scenarios, 'scenario');
  assertUniqueNames(parsed.viewports, 'viewport');

  const secrets: Record<string, string> = {};
  for (const [name, environmentName] of Object.entries(parsed.secrets)) {
    const value = environment[environmentName];
    if (!value) {
      throw new Error(`Required secret environment variable is missing: ${environmentName}`);
    }
    secrets[name] = value;
  }

  return {
    ...parsed,
    scenarios: input.scenarios.map((scenario, index) => ({
      ...parsed.scenarios[index],
      run: scenario.run
    })) as ScenarioDefinition[],
    secrets,
    secretValues: Object.values(secrets)
  };
}

export async function loadConfig(
  configPath = 'argus.config.ts',
  environment: NodeJS.ProcessEnv = process.env
): Promise<ResolvedArgusConfig> {
  const absolutePath = resolve(configPath);
  await access(absolutePath);
  const jiti = createJiti(pathToFileURL(import.meta.url).href);
  const loaded = await jiti.import<ArgusConfigInput>(absolutePath, { default: true });
  const config = resolveConfig(loaded, environment);
  config.artifactDir = resolve(config.artifactDir);
  config.compose.file = resolve(config.compose.file);
  await mkdir(config.artifactDir, { recursive: true });
  return config;
}
