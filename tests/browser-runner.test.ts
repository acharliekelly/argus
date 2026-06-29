import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import { BrowserRunner } from '../src/browser/runner.js';
import { RunStore } from '../src/run-store.js';

function image(color: number): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = color;
    png.data[index + 1] = color;
    png.data[index + 2] = color;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('BrowserRunner', () => {
  it('runs scenarios at every viewport with stable screenshot names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-browser-'));
    const store = new RunStore(root);
    await store.createRun('run-1');
    const screenshot = vi.fn().mockImplementation(async ({ path }: { path: string }) => {
      await writeFile(path, image(255));
    });
    const page = {
      setViewportSize: vi.fn(),
      goto: vi.fn(),
      locator: vi.fn((selector: string) => ({ selector, waitFor: vi.fn() })),
      screenshot,
      close: vi.fn()
    };
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn() };
    const scenarioRun = vi.fn();
    const runner = new BrowserRunner(
      {
        baseUrl: 'http://localhost:8093',
        visualThreshold: 0.01,
        scenarios: [{ name: 'home page', path: '/', mask: ['.clock'], run: scenarioRun }],
        viewports: [
          { name: 'desktop', width: 1280, height: 720 },
          { name: 'mobile', width: 390, height: 844 }
        ],
        secrets: {}
      },
      store,
      async () => browser
    );

    const result = await runner.run('run-1', 'baseline');

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(scenarioRun).toHaveBeenCalledTimes(2);
    expect(screenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringContaining('home-page--desktop.png'),
        fullPage: true,
        mask: [expect.objectContaining({ selector: '.clock' })]
      })
    );
  });

  it('records a failed functional scenario and preserves a failure screenshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-browser-'));
    const store = new RunStore(root);
    await store.createRun('run-1');
    const page = {
      setViewportSize: vi.fn(),
      goto: vi.fn(),
      locator: vi.fn((selector: string) => ({ selector, waitFor: vi.fn() })),
      screenshot: vi.fn().mockImplementation(async ({ path }: { path: string }) => {
        await writeFile(path, image(255));
      }),
      close: vi.fn()
    };
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn() };
    const runner = new BrowserRunner(
      {
        baseUrl: 'http://localhost:8093',
        visualThreshold: 0.01,
        scenarios: [
          {
            name: 'home',
            path: '/',
            run: async () => {
              throw new Error('missing heading');
            }
          }
        ],
        viewports: [{ name: 'desktop', width: 1280, height: 720 }],
        secrets: {}
      },
      store,
      async () => browser
    );

    const result = await runner.run('run-1', 'after');

    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({
      passed: false,
      error: 'missing heading'
    });
    expect(result.checks[0]?.failureScreenshotPath).toContain('failure.png');
  });

  it('waits for the body to be visible before capturing declarative scenarios', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-browser-'));
    const store = new RunStore(root);
    await store.createRun('run-1');
    const bodyWaitFor = vi.fn();
    const page = {
      setViewportSize: vi.fn(),
      goto: vi.fn(),
      locator: vi.fn((selector: string) => ({ selector, waitFor: bodyWaitFor })),
      screenshot: vi.fn().mockImplementation(async ({ path }: { path: string }) => {
        await writeFile(path, image(255));
      }),
      close: vi.fn()
    };
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn() };
    const runner = new BrowserRunner(
      {
        baseUrl: 'http://localhost:8093',
        visualThreshold: 0.01,
        scenarios: [{ name: 'home', path: '/' }],
        viewports: [{ name: 'desktop', width: 1280, height: 720 }],
        secrets: {}
      },
      store,
      async () => browser
    );

    await runner.run('run-1', 'baseline');

    expect(page.locator).toHaveBeenCalledWith('body');
    expect(bodyWaitFor).toHaveBeenCalledWith({ state: 'visible' });
  });

  it('waits for every configured visible selector before screenshot capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-browser-'));
    const store = new RunStore(root);
    await store.createRun('run-1');
    const calls: string[] = [];
    const page = {
      setViewportSize: vi.fn(),
      goto: vi.fn(),
      locator: vi.fn((selector: string) => ({
        selector,
        waitFor: vi.fn(async () => {
          calls.push(`visible:${selector}`);
        })
      })),
      screenshot: vi.fn().mockImplementation(async ({ path }: { path: string }) => {
        calls.push('screenshot');
        await writeFile(path, image(255));
      }),
      close: vi.fn()
    };
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn() };
    const runner = new BrowserRunner(
      {
        baseUrl: 'http://localhost:8093',
        visualThreshold: 0.01,
        scenarios: [{ name: 'home', path: '/', visibleSelectors: ['main', 'h1'] }],
        viewports: [{ name: 'desktop', width: 1280, height: 720 }],
        secrets: {}
      },
      store,
      async () => browser
    );

    await runner.run('run-1', 'baseline');

    expect(calls).toEqual(['visible:main', 'visible:h1', 'screenshot']);
  });

  it('compares baseline and after screenshots and writes a diff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'argus-browser-'));
    const store = new RunStore(root);
    await store.createRun('run-1');
    await store.ensureRunDirectory('run-1', 'screenshots/baseline');
    await store.ensureRunDirectory('run-1', 'screenshots/after');
    await writeFile(
      store.runPath('run-1', 'screenshots/baseline/home--desktop.png'),
      image(255)
    );
    await writeFile(
      store.runPath('run-1', 'screenshots/after/home--desktop.png'),
      image(0)
    );
    const runner = new BrowserRunner(
      {
        baseUrl: 'http://localhost:8093',
        visualThreshold: 0.5,
        scenarios: [{ name: 'home', path: '/' }],
        viewports: [{ name: 'desktop', width: 1280, height: 720 }],
        secrets: {}
      },
      store,
      async () => {
        throw new Error('not used');
      }
    );

    const result = await runner.compare('run-1');

    expect(result.passed).toBe(false);
    expect(result.comparisons[0]).toMatchObject({
      changedRatio: 1,
      passed: false
    });
    await expect(
      readFile(store.runPath('run-1', 'screenshots/diff/home--desktop.png'))
    ).resolves.toBeInstanceOf(Buffer);
  });
});
