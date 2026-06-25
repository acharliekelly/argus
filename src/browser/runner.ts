import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { RunStore } from '../run-store.js';
import type {
  ScenarioDefinition,
  ScenarioContext,
  ViewportDefinition
} from '../types.js';
import { compareImages } from './visual.js';

type BrowserSettings = {
  baseUrl: string;
  visualThreshold: number;
  scenarios: ScenarioDefinition[];
  viewports: ViewportDefinition[];
  secrets: Record<string, string>;
};

export type BrowserCheck = {
  scenario: string;
  viewport: string;
  url: string;
  passed: boolean;
  durationMs: number;
  screenshotPath: string | null;
  failureScreenshotPath?: string;
  error?: string;
};

export type VisualCheck = {
  scenario: string;
  viewport: string;
  passed: boolean;
  dimensionsMatch: boolean;
  changedPixels: number;
  changedRatio: number;
  threshold: number;
  baselinePath: string;
  afterPath: string;
  diffPath: string | null;
};

type LaunchBrowser = () => Promise<Pick<Browser, 'newPage' | 'close'>>;

export class BrowserRunner {
  constructor(
    private readonly settings: BrowserSettings,
    private readonly store: RunStore,
    private readonly launchBrowser: LaunchBrowser = async () => chromium.launch()
  ) {}

  async run(
    runId: string,
    phase: 'baseline' | 'after' | 'rollback'
  ): Promise<{ passed: boolean; checks: BrowserCheck[] }> {
    const browser = await this.launchBrowser();
    const checks: BrowserCheck[] = [];
    try {
      for (const scenario of this.settings.scenarios) {
        for (const viewport of this.settings.viewports) {
          checks.push(await this.runScenario(browser, runId, phase, scenario, viewport));
        }
      }
    } finally {
      await browser.close();
    }
    return { passed: checks.every(({ passed }) => passed), checks };
  }

  private async runScenario(
    browser: Pick<Browser, 'newPage'>,
    runId: string,
    phase: 'baseline' | 'after' | 'rollback',
    scenario: ScenarioDefinition,
    viewport: ViewportDefinition
  ): Promise<BrowserCheck> {
    const page = await browser.newPage();
    const startedAt = performance.now();
    const stem = `${safeName(scenario.name)}--${safeName(viewport.name)}`;
    const screenshotPath = this.store.runPath(
      runId,
      'screenshots',
      phase,
      `${stem}.png`
    );
    const failureScreenshotPath = this.store.runPath(
      runId,
      'screenshots',
      phase,
      `${stem}--failure.png`
    );
    const url = new URL(scenario.path, this.settings.baseUrl).toString();
    await mkdir(dirname(screenshotPath), { recursive: true });

    try {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(url, { waitUntil: 'networkidle' });
      const context: ScenarioContext = {
        baseUrl: this.settings.baseUrl,
        secrets: this.settings.secrets
      };
      await scenario.run?.(page, context);
      await page.screenshot({
        path: screenshotPath,
        fullPage: true,
        mask: (scenario.mask ?? []).map((selector) => page.locator(selector))
      });
      return {
        scenario: scenario.name,
        viewport: viewport.name,
        url,
        passed: true,
        durationMs: Math.round(performance.now() - startedAt),
        screenshotPath: this.relativeToRun(runId, screenshotPath)
      };
    } catch (error) {
      await page.screenshot({ path: failureScreenshotPath, fullPage: true }).catch(() => undefined);
      return {
        scenario: scenario.name,
        viewport: viewport.name,
        url,
        passed: false,
        durationMs: Math.round(performance.now() - startedAt),
        screenshotPath: null,
        failureScreenshotPath: this.relativeToRun(runId, failureScreenshotPath),
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      await page.close();
    }
  }

  async compare(
    runId: string
  ): Promise<{ passed: boolean; comparisons: VisualCheck[] }> {
    const comparisons: VisualCheck[] = [];
    for (const scenario of this.settings.scenarios) {
      for (const viewport of this.settings.viewports) {
        const stem = `${safeName(scenario.name)}--${safeName(viewport.name)}`;
        const baselinePath = this.store.runPath(
          runId,
          'screenshots',
          'baseline',
          `${stem}.png`
        );
        const afterPath = this.store.runPath(
          runId,
          'screenshots',
          'after',
          `${stem}.png`
        );
        const diffPath = this.store.runPath(
          runId,
          'screenshots',
          'diff',
          `${stem}.png`
        );
        const threshold = scenario.visualThreshold ?? this.settings.visualThreshold;
        const result = compareImages(
          await readFile(baselinePath),
          await readFile(afterPath),
          threshold
        );
        if (result.diff) {
          await mkdir(dirname(diffPath), { recursive: true });
          await writeFile(diffPath, result.diff);
        }
        comparisons.push({
          scenario: scenario.name,
          viewport: viewport.name,
          passed: result.passed,
          dimensionsMatch: result.dimensionsMatch,
          changedPixels: result.changedPixels,
          changedRatio: result.changedRatio,
          threshold,
          baselinePath: this.relativeToRun(runId, baselinePath),
          afterPath: this.relativeToRun(runId, afterPath),
          diffPath: result.diff ? this.relativeToRun(runId, diffPath) : null
        });
      }
    }
    return {
      passed: comparisons.every(({ passed }) => passed),
      comparisons
    };
  }

  private relativeToRun(runId: string, path: string): string {
    return relative(this.store.runPath(runId), path);
  }
}

function safeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export type { Page };
