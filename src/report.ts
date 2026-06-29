import { z } from 'zod';
import type { CommandRecord, SiteIdentity, SiteInventory, UpdateTarget } from './types.js';

const targetSchema = z.object({
  type: z.enum(['plugin', 'theme', 'core']),
  slug: z.string()
});

const snapshotSchema = z
  .object({
    databasePath: z.string(),
    contentPath: z.string(),
    createdAt: z.string()
  })
  .nullable();

const rollbackSchema = z
  .object({
    completedAt: z.string(),
    passed: z.boolean()
  })
  .nullable();

const siteIdentitySchema = z.object({
  name: z.string().min(1),
  fingerprint: z.string().min(1)
});

const reportFields = {
  runId: z.string().min(1),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  status: z.enum(['running', 'passed', 'failed', 'aborted', 'rolled_back']),
  target: targetSchema,
  reasonCodes: z.array(z.string()),
  recommendation: z.enum(['accept', 'rollback', 'investigate']),
  inventory: z.object({
    before: z.custom<SiteInventory>().nullable(),
    after: z.custom<SiteInventory>().nullable()
  }),
  preflight: z.array(z.object({ name: z.string(), passed: z.boolean(), message: z.string() })),
  commands: z.array(z.custom<CommandRecord>()),
  checks: z.object({
    baseline: z.array(z.unknown()),
    after: z.array(z.unknown()),
    visual: z.array(z.unknown()),
    rollback: z.array(z.unknown())
  }),
  snapshot: snapshotSchema,
  rollback: rollbackSchema
};

const legacyReportSchema = z.object({
  schemaVersion: z.literal(1),
  ...reportFields
});

const currentReportSchema = z.object({
  schemaVersion: z.literal(2),
  site: siteIdentitySchema.nullable(),
  ...reportFields
});

export const reportSchema = z.union([currentReportSchema, legacyReportSchema]);

export type ArgusReport = z.infer<typeof reportSchema>;
export type CurrentArgusReport = z.infer<typeof currentReportSchema>;

export function createInitialReport(
  runId: string,
  target: UpdateTarget,
  site: SiteIdentity | null = null
): CurrentArgusReport {
  return {
    schemaVersion: 2,
    site,
    runId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    target,
    reasonCodes: [],
    recommendation: 'investigate',
    inventory: { before: null, after: null },
    preflight: [],
    commands: [],
    checks: { baseline: [], after: [], visual: [], rollback: [] },
    snapshot: null,
    rollback: null
  };
}

export function deriveRecommendation(input: {
  baselinePassed: boolean;
  updatePassed: boolean;
  postUpdatePassed: boolean;
  visualPassed: boolean;
}): ArgusReport['recommendation'] {
  if (!input.baselinePassed || !input.updatePassed) {
    return 'investigate';
  }
  if (!input.postUpdatePassed || !input.visualPassed) {
    return 'rollback';
  }
  return 'accept';
}

export function redactValue<T>(value: T, secrets: string[]): T {
  return redactUnknown(value, secrets) as T;
}

function redactUnknown(value: unknown, secrets: string[]): unknown {
  const usableSecrets = secrets.filter(Boolean);
  const redactString = (input: string): string =>
    usableSecrets.reduce(
      (current, secret) => current.split(secret).join('[REDACTED]'),
      input
    );

  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, usableSecrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactUnknown(item, usableSecrets)])
    );
  }
  return value;
}
