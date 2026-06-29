import { describe, expect, it } from 'vitest';
import {
  assertSiteFingerprint,
  computeSiteFingerprint,
  siteFingerprintSource
} from '../src/sites/fingerprint.js';
import type { DiscoveredSite } from '../src/sites/discovery.js';

const discoveredSite: DiscoveredSite = {
  composeFile: '/srv/site/docker-compose.yml',
  projectDirectory: '/srv/site',
  projectName: 'site_project',
  wordpressService: 'wordpress',
  containerId: 'container-id',
  baseUrl: 'http://localhost:8090',
  networkName: 'site_project_default',
  wordpressMount: {
    type: 'volume',
    source: 'site_project_wordpress',
    destination: '/var/www/html'
  },
  wordpressEnvironment: {
    WORDPRESS_DB_HOST: 'db:3306',
    WORDPRESS_DB_NAME: 'wordpress',
    WORDPRESS_DB_USER: 'wp_user',
    WORDPRESS_DB_PASSWORD: 'secret'
  }
};

describe('site fingerprint', () => {
  it('hashes canonical site identity JSON only from stable target fields', () => {
    expect(siteFingerprintSource(discoveredSite)).toEqual({
      databaseHost: 'db:3306',
      databaseName: 'wordpress',
      projectName: 'site_project',
      wordpressMount: {
        destination: '/var/www/html',
        source: 'site_project_wordpress',
        type: 'volume'
      },
      wordpressService: 'wordpress'
    });
    expect(computeSiteFingerprint(discoveredSite)).toBe(
      'sha256:8c7dfd726106f40564e8f24dbe3f8fcf2b78fc2b8d7daaa0273555c0f9d7d572'
    );
    expect(
      computeSiteFingerprint({
        ...discoveredSite,
        containerId: 'new-container-id',
        baseUrl: 'http://localhost:9000',
        wordpressEnvironment: {
          ...discoveredSite.wordpressEnvironment,
          WORDPRESS_DB_PASSWORD: 'rotated-secret'
        }
      })
    ).toBe(computeSiteFingerprint(discoveredSite));
  });

  it('rejects rollback when the current fingerprint differs from the expected value', () => {
    const expected = computeSiteFingerprint(discoveredSite);
    const movedSite = {
      ...discoveredSite,
      wordpressMount: { ...discoveredSite.wordpressMount, source: 'other_volume' }
    };

    expect(assertSiteFingerprint(discoveredSite, expected)).toEqual({
      matched: true,
      expected,
      current: expected
    });
    expect(() => assertSiteFingerprint(movedSite, expected)).toThrow(
      /^target_fingerprint_mismatch:/
    );
  });
});
