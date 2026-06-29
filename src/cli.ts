#!/usr/bin/env node
import { Command, Option } from 'commander';
import {
  assertSafeRunId,
  createRunId,
  exitCodeForReport,
  renderReportSummary,
  resolveRuntimeSelection
} from './cli-support.js';
import {
  connectSiteCommand,
  disconnectSiteCommand,
  editSiteCommand,
  listSitesCommand,
  showSiteCommand,
  type ConnectSiteCommandInput
} from './sites/commands.js';
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

export type SiteCommandHandlers = {
  connect(input: ConnectSiteCommandInput): Promise<string>;
  list(): Promise<string>;
  show(name: string): Promise<string>;
  edit(name: string): Promise<string>;
  disconnect(name: string): Promise<string>;
};

export type CreateProgramOptions = {
  siteCommands?: SiteCommandHandlers;
  write?: (output: string) => void;
};

export function createProgram(options: CreateProgramOptions = {}): Command {
  const siteCommands = options.siteCommands ?? defaultSiteCommandHandlers();
  const write = options.write ?? ((output: string) => console.log(output));
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

  program
    .command('connect')
    .description('Connect Argus to a named WordPress site')
    .argument('<name>', 'saved site name')
    .requiredOption('--compose <file>', 'Docker Compose file')
    .option('--wordpress-service <service>', 'WordPress Compose service')
    .option('--url <url>', 'WordPress site URL')
    .option('--helper-image <image>', 'WordPress CLI helper image')
    .option('--force', 'overwrite an existing site profile', false)
    .action(
      async (
        name: string,
        commandOptions: {
          compose: string;
          wordpressService?: string;
          url?: string;
          helperImage?: string;
          force: boolean;
        }
      ) => {
        const input: ConnectSiteCommandInput = {
          name,
          composeFile: commandOptions.compose,
          ...(commandOptions.wordpressService === undefined
            ? {}
            : { wordpressService: commandOptions.wordpressService }),
          ...(commandOptions.url === undefined ? {} : { baseUrl: commandOptions.url }),
          ...(commandOptions.helperImage === undefined
            ? {}
            : { helperImage: commandOptions.helperImage }),
          force: commandOptions.force
        };
        write(await siteCommands.connect(input));
      }
    );

  const site = program.command('site').description('Manage saved named site profiles');

  site
    .command('list')
    .description('List saved site names')
    .action(async () => {
      write(await siteCommands.list());
    });

  site
    .command('show')
    .description('Show a saved site profile as JSON')
    .argument('<name>', 'saved site name')
    .action(async (name: string) => {
      write(await siteCommands.show(name));
    });

  site
    .command('edit')
    .description('Edit a saved site profile')
    .argument('<name>', 'saved site name')
    .action(async (name: string) => {
      write(await siteCommands.edit(name));
    });

  site
    .command('disconnect')
    .description('Remove a saved site profile')
    .argument('<name>', 'saved site name')
    .action(async (name: string) => {
      write(await siteCommands.disconnect(name));
    });

  return program;
}

function defaultSiteCommandHandlers(): SiteCommandHandlers {
  return {
    connect: connectSiteCommand,
    list: listSitesCommand,
    show: showSiteCommand,
    edit: editSiteCommand,
    disconnect: disconnectSiteCommand
  };
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
