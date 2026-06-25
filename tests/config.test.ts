import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';

const baseConfig = {
  baseUrl: 'http://localhost:8093',
  compose: { wordpressService: 'wordpress', wpCliService: 'wpcli' },
  scenarios: [{ name: 'home', path: '/' }],
  viewports: [{ name: 'desktop', width: 1280, height: 720 }]
};

describe('resolveConfig', () => {
  it('resolves secret environment variables without retaining their names as values', () => {
    const config = resolveConfig(
      { ...baseConfig, secrets: { adminPassword: 'ARGUS_ADMIN_PASSWORD' } },
      { ARGUS_ADMIN_PASSWORD: 'super-secret' }
    );

    expect(config.secrets.adminPassword).toBe('super-secret');
    expect(config.secretValues).toEqual(['super-secret']);
  });

  it('rejects duplicate scenario names', () => {
    expect(() =>
      resolveConfig({
        ...baseConfig,
        scenarios: [
          { name: 'home', path: '/' },
          { name: 'home', path: '/again' }
        ]
      })
    ).toThrow(/duplicate scenario/i);
  });

  it('rejects unresolved required secrets', () => {
    expect(() =>
      resolveConfig(
        { ...baseConfig, secrets: { adminPassword: 'ARGUS_ADMIN_PASSWORD' } },
        {}
      )
    ).toThrow(/ARGUS_ADMIN_PASSWORD/);
  });

  it('rejects invalid visual thresholds', () => {
    expect(() =>
      resolveConfig({
        ...baseConfig,
        visualThreshold: 1.1
      })
    ).toThrow();
  });
});
