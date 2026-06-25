import { z } from 'zod';
import { SITE_NAME_PATTERN } from './paths.js';

export const declarativeScenarioSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().startsWith('/'),
    mask: z.array(z.string().min(1)).default([]),
    visualThreshold: z.number().min(0).max(1).default(0.01),
    visibleSelectors: z.array(z.string().min(1)).default(['body'])
  })
  .strict();

export const viewportSchema = z
  .object({
    name: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
  .strict();

const defaultScenarios = [
  {
    name: 'homepage',
    path: '/',
    mask: ['#wpadminbar'],
    visualThreshold: 0.01,
    visibleSelectors: ['body']
  }
];

const defaultViewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 }
];

export const siteProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().regex(SITE_NAME_PATTERN),
    composeFile: z.string().min(1),
    projectDirectory: z.string().min(1),
    projectName: z.string().min(1),
    wordpressService: z.string().min(1),
    baseUrl: z.string().url(),
    helperImage: z.string().min(1).default('wordpress:cli'),
    wordpressMount: z
      .object({
        type: z.enum(['bind', 'volume']),
        source: z.string().min(1),
        destination: z.literal('/var/www/html')
      })
      .strict(),
    networkName: z.string().min(1),
    scenarios: z
      .array(declarativeScenarioSchema)
      .min(1)
      .superRefine((scenarios, context) => {
        addDuplicateNameIssues(scenarios, 'scenario', context);
      })
      .default(defaultScenarios),
    viewports: z
      .array(viewportSchema)
      .min(1)
      .superRefine((viewports, context) => {
        addDuplicateNameIssues(viewports, 'viewport', context);
      })
      .default(defaultViewports)
  })
  .strict();

export type SiteProfile = z.output<typeof siteProfileSchema>;
export type SiteProfileInput = z.input<typeof siteProfileSchema>;

function addDuplicateNameIssues(
  items: Array<{ name: string }>,
  label: string,
  context: z.RefinementCtx
): void {
  const names = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (names.has(item.name)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate ${label} name: ${item.name}`,
        path: [index, 'name']
      });
    }
    names.add(item.name);
  }
}
