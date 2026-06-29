import { describe, expect, it, vi } from 'vitest';
import {
  createRunId,
  exitCodeForStatus,
  renderReportSummary,
  resolveRuntimeSelection
} from '../src/cli-support.js';
import { createProgram } from '../src/cli.js';
import { createInitialReport } from '../src/report.js';

describe('CLI support', () => {
  it('creates filesystem-safe run IDs', () => {
    expect(createRunId(new Date('2026-06-25T03:04:05.678Z'))).toBe(
      '20260625T030405678Z'
    );
  });

  it('maps passed and rolled-back reports to success', () => {
    expect(exitCodeForStatus('passed')).toBe(0);
    expect(exitCodeForStatus('rolled_back')).toBe(0);
    expect(exitCodeForStatus('failed')).toBe(1);
    expect(exitCodeForStatus('aborted')).toBe(1);
  });

  it('renders a concise summary from report data', () => {
    const report = createInitialReport('run-1', { type: 'plugin', slug: 'demo' });
    report.status = 'failed';
    report.recommendation = 'rollback';
    report.reasonCodes = ['visual_regression'];

    expect(renderReportSummary(report)).toContain('run-1');
    expect(renderReportSummary(report)).toContain('visual_regression');
    expect(renderReportSummary(report)).toContain('rollback');
  });

  it('uses config mode for the default config value when no site is provided', () => {
    expect(
      resolveRuntimeSelection(
        { config: 'argus.config.ts' },
        (name) => (name === 'config' ? 'default' : undefined)
      )
    ).toEqual({
      mode: 'config',
      configPath: 'argus.config.ts'
    });
  });

  it('uses site mode when only a named site is provided', () => {
    expect(
      resolveRuntimeSelection(
        { config: 'argus.config.ts', site: 'wp-melroseuu' },
        (name) => (name === 'config' ? 'default' : name === 'site' ? 'cli' : undefined)
      )
    ).toEqual({
      mode: 'site',
      site: 'wp-melroseuu'
    });
  });

  it('rejects site mode when config was explicitly supplied', () => {
    expect(() =>
      resolveRuntimeSelection(
        { config: 'custom.config.ts', site: 'wp-melroseuu' },
        (name) => (name === 'config' ? 'cli' : name === 'site' ? 'cli' : undefined)
      )
    ).toThrow('--site cannot be used with --config');
  });

  it('wires named-site management subcommands through Commander', async () => {
    const write = vi.fn();
    const siteCommands = {
      connect: vi.fn().mockResolvedValue('connected'),
      list: vi.fn().mockResolvedValue('alpha\nzeta'),
      show: vi.fn().mockResolvedValue('{"name":"alpha"}'),
      edit: vi.fn().mockResolvedValue('updated'),
      disconnect: vi.fn().mockResolvedValue('disconnected')
    };
    const program = createProgram({ siteCommands, write });

    await program.parseAsync([
      'node',
      'argus',
      'connect',
      'wp-melroseuu',
      '--compose',
      '/site/docker-compose.yml',
      '--wordpress-service',
      'wordpress',
      '--url',
      'http://localhost:8090',
      '--helper-image',
      'wordpress:cli-php8.3',
      '--force'
    ]);
    await program.parseAsync(['node', 'argus', 'site', 'list']);
    await program.parseAsync(['node', 'argus', 'site', 'show', 'wp-melroseuu']);
    await program.parseAsync(['node', 'argus', 'site', 'edit', 'wp-melroseuu']);
    await program.parseAsync(['node', 'argus', 'site', 'disconnect', 'wp-melroseuu']);

    expect(siteCommands.connect).toHaveBeenCalledWith({
      name: 'wp-melroseuu',
      composeFile: '/site/docker-compose.yml',
      wordpressService: 'wordpress',
      baseUrl: 'http://localhost:8090',
      helperImage: 'wordpress:cli-php8.3',
      force: true
    });
    expect(siteCommands.list).toHaveBeenCalledWith();
    expect(siteCommands.show).toHaveBeenCalledWith('wp-melroseuu');
    expect(siteCommands.edit).toHaveBeenCalledWith('wp-melroseuu');
    expect(siteCommands.disconnect).toHaveBeenCalledWith('wp-melroseuu');
    expect(write).toHaveBeenCalledWith('connected');
    expect(write).toHaveBeenCalledWith('alpha\nzeta');
    expect(write).toHaveBeenCalledWith('{"name":"alpha"}');
    expect(write).toHaveBeenCalledWith('updated');
    expect(write).toHaveBeenCalledWith('disconnected');
  });
});
