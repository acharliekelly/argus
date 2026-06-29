#!/usr/bin/env node
import { Command, Option } from 'commander';
import {
  assertSafeRunId,
  createRunId,
  exitCodeForReport,
  renderReportSummary,
  resolveRuntimeSelection
} from './cli-support.js';
import { createConfigRuntime, createSiteRuntime, type ArgusRuntime } from './sites/runtime.js';
import type { UpdateTarget } from './types.js';

type GlobalOptions = {
  config: string;
  site?: string;
};

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

async function createRuntime(command: Command): Promise<ArgusRuntime> {
  const selection = resolveRuntimeSelection(globalOptions(command), (name) =>
    command.getOptionValueSourceWithGlobals(name)
  );
  if (selection.mode === 'site') {
    return createSiteRuntime(selection.site);
  }
  return createConfigRuntime(selection.configPath);
}

export function createProgram(): Command {
  const program = new Command()
    .name('argus')
    .description('Safely evaluate WordPress plugin and theme updates')
    .version('0.1.0')
    .option('-c, --config <path>', 'configuration file', 'argus.config.ts')
    .addOption(new Option('--site <name>', 'saved named site profile'));

  program
    .command('inventory')
    .description('Print the current WordPress inventory')
    .action(async (_options, command: Command) => {
      const runtime = await createRuntime(command);
      const preflight = await runtime.wordpress.preflight();
      if (preflight.some(({ passed }) => !passed)) {
        console.error(JSON.stringify({ preflight }, null, 2));
        process.exitCode = 2;
        return;
      }
      console.log(JSON.stringify(await runtime.wordpress.inventory(), null, 2));
    });

  program
    .command('check')
    .description('Run configured functional checks and capture baseline screenshots')
    .action(async (_options, command: Command) => {
      const runtime = await createRuntime(command);
      const runId = `check-${createRunId()}`;
      await runtime.store.createRun(runId);
      const result = await runtime.browser.run(runId, 'baseline');
      await runtime.store.writeJson(runId, 'check.json', result);
      console.log(`Run: ${runId}\nStatus: ${result.passed ? 'passed' : 'failed'}`);
      process.exitCode = result.passed ? 0 : 1;
    });

  program
    .command('update')
    .description('Update one plugin or theme and evaluate the result')
    .addOption(
      new Option('--type <type>', 'component type').choices(['plugin', 'theme']).makeOptionMandatory()
    )
    .requiredOption('--slug <slug>', 'plugin or theme slug')
    .action(async (options: { type: 'plugin' | 'theme'; slug: string }, command: Command) => {
      const runtime = await createRuntime(command);
      const runId = createRunId();
      await runtime.lock.acquire(runId);
      try {
        const target: UpdateTarget = { type: options.type, slug: options.slug };
        const report = await runtime.orchestrator.update(target, runId);
        console.log(renderReportSummary(report));
        process.exitCode = exitCodeForReport(report);
      } finally {
        await runtime.lock.release();
      }
    });

  program
    .command('rollback')
    .description('Restore the database and wp-content snapshot for a previous run')
    .requiredOption('--run <run-id>', 'run ID to restore')
    .action(async (options: { run: string }, command: Command) => {
      assertSafeRunId(options.run);
      const runtime = await createRuntime(command);
      await runtime.lock.acquire(`rollback-${options.run}`);
      try {
        const report = await runtime.orchestrator.rollback(options.run);
        console.log(renderReportSummary(report));
        process.exitCode = exitCodeForReport(report);
      } finally {
        await runtime.lock.release();
      }
    });

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Argus error: ${message}`);
    process.exitCode = 2;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  await main();
}
