import { describe, expect, it, vi } from 'vitest';
import { WordPressAdapter } from '../src/wordpress/adapter.js';
import type { ProcessRunnerLike } from '../src/process.js';

function result(stdout: string, exitCode = 0) {
  return {
    command: 'docker',
    args: [],
    stdout,
    stderr: '',
    exitCode,
    durationMs: 1
  };
}

describe('WordPressAdapter', () => {
  it('collects normalized core, plugin, and theme inventory', async () => {
    const run = vi
      .fn<ProcessRunnerLike['run']>()
      .mockResolvedValueOnce(result('7.0'))
      .mockResolvedValueOnce(result('[{"version":"7.0.1"}]'))
      .mockResolvedValueOnce(
        result(
          '[{"name":"demo","status":"active","version":"1.0.0","update":"available","update_version":"2.0.0"}]'
        )
      )
      .mockResolvedValueOnce(result('[]'));
    const adapter = new WordPressAdapter(
      { run },
      { file: 'docker-compose.yml', wpCliService: 'wpcli', wordpressService: 'wordpress' }
    );

    await expect(adapter.inventory()).resolves.toEqual({
      core: { version: '7.0', updateVersion: '7.0.1' },
      plugins: [
        { slug: 'demo', status: 'active', version: '1.0.0', updateVersion: '2.0.0' }
      ],
      themes: []
    });
  });

  it('updates only plugin or theme targets', async () => {
    const run = vi.fn<ProcessRunnerLike['run']>().mockResolvedValue(result('Success'));
    const adapter = new WordPressAdapter(
      { run },
      { file: 'docker-compose.yml', wpCliService: 'wpcli', wordpressService: 'wordpress' }
    );

    await adapter.update({ type: 'plugin', slug: 'demo' });

    expect(run).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['plugin', 'update', 'demo'])
    );
  });
});
