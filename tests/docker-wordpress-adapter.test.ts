import { describe, expect, it, vi } from 'vitest';
import { DockerWordPressAdapter } from '../src/wordpress/docker-adapter.js';
import type { CommandRecord } from '../src/types.js';

function result(stdout: string, exitCode = 0): CommandRecord {
  return {
    command: 'docker',
    args: [],
    stdout,
    stderr: '',
    exitCode,
    durationMs: 1
  };
}

function createHelper() {
  return {
    runWp: vi.fn(),
    runUtility: vi.fn(),
    runUtilityBuffer: vi.fn()
  };
}

describe('DockerWordPressAdapter', () => {
  it('preflights Docker helper connectivity and WordPress installation', async () => {
    const helper = createHelper();
    helper.runUtility.mockResolvedValueOnce(result(''));
    helper.runWp.mockResolvedValueOnce(result(''));
    const adapter = new DockerWordPressAdapter(helper);

    await expect(adapter.preflight()).resolves.toEqual([
      { name: 'docker', passed: true, message: 'Docker helper container is reachable' },
      { name: 'wordpress', passed: true, message: 'WordPress is installed' }
    ]);
    expect(helper.runUtility).toHaveBeenCalledWith(['true']);
    expect(helper.runWp).toHaveBeenCalledWith(['core', 'is-installed']);
  });

  it('stops preflight when Docker helper connectivity fails', async () => {
    const helper = createHelper();
    helper.runUtility.mockResolvedValueOnce({ ...result('', 1), stderr: 'Cannot connect' });
    const adapter = new DockerWordPressAdapter(helper);

    await expect(adapter.preflight()).resolves.toEqual([
      { name: 'docker', passed: false, message: 'Cannot connect' }
    ]);
    expect(helper.runWp).not.toHaveBeenCalled();
  });

  it('collects normalized core, plugin, and theme inventory through runWp', async () => {
    const helper = createHelper();
    helper.runWp
      .mockResolvedValueOnce(result('7.0'))
      .mockResolvedValueOnce(result('[{"version":"7.0.1"}]'))
      .mockResolvedValueOnce(
        result(
          '[{"name":"demo","status":"active","version":"1.0.0","update":"available","update_version":"2.0.0"}]'
        )
      )
      .mockResolvedValueOnce(
        result('[{"name":"theme-demo","status":"inactive","version":"3.0.0","update":"none"}]')
      );
    const adapter = new DockerWordPressAdapter(helper);

    await expect(adapter.inventory()).resolves.toEqual({
      core: { version: '7.0', updateVersion: '7.0.1' },
      plugins: [
        { slug: 'demo', status: 'active', version: '1.0.0', updateVersion: '2.0.0' }
      ],
      themes: [
        { slug: 'theme-demo', status: 'inactive', version: '3.0.0', updateVersion: null }
      ]
    });
    expect(helper.runWp).toHaveBeenNthCalledWith(1, ['core', 'version']);
    expect(helper.runWp).toHaveBeenNthCalledWith(2, ['core', 'check-update', '--format=json']);
    expect(helper.runWp).toHaveBeenNthCalledWith(3, ['plugin', 'list', '--format=json']);
    expect(helper.runWp).toHaveBeenNthCalledWith(4, ['theme', 'list', '--format=json']);
  });

  it('updates plugin and theme targets but rejects core updates', async () => {
    const helper = createHelper();
    helper.runWp.mockResolvedValue(result('Success'));
    const adapter = new DockerWordPressAdapter(helper);

    await adapter.update({ type: 'plugin', slug: 'demo' });
    await adapter.update({ type: 'theme', slug: 'theme-demo' });

    expect(helper.runWp).toHaveBeenNthCalledWith(1, ['plugin', 'update', 'demo']);
    expect(helper.runWp).toHaveBeenNthCalledWith(2, ['theme', 'update', 'theme-demo']);
    await expect(adapter.update({ type: 'core', slug: 'wordpress' })).rejects.toThrow(
      /^unsupported_target:/
    );
  });
});
