import { createHash } from 'node:crypto';
import type { DiscoveredSite } from './discovery.js';

export type SiteFingerprintSource = {
  databaseHost: string;
  databaseName: string;
  projectName: string;
  wordpressMount: DiscoveredSite['wordpressMount'];
  wordpressService: string;
};

export type SiteFingerprintMatch = {
  matched: true;
  expected: string;
  current: string;
};

export function siteFingerprintSource(site: DiscoveredSite): SiteFingerprintSource {
  return {
    databaseHost: site.wordpressEnvironment.WORDPRESS_DB_HOST ?? '',
    databaseName: site.wordpressEnvironment.WORDPRESS_DB_NAME ?? '',
    projectName: site.projectName,
    wordpressMount: {
      destination: site.wordpressMount.destination,
      source: site.wordpressMount.source,
      type: site.wordpressMount.type
    },
    wordpressService: site.wordpressService
  };
}

export function computeSiteFingerprint(site: DiscoveredSite): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(siteFingerprintSource(site)))
    .digest('hex')}`;
}

export function assertSiteFingerprint(
  site: DiscoveredSite,
  expected: string
): SiteFingerprintMatch {
  const current = computeSiteFingerprint(site);
  if (current !== expected) {
    throw new Error(
      `target_fingerprint_mismatch: expected ${expected} for rollback target but found ${current}`
    );
  }
  return { matched: true, expected, current };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortCanonical(nested)])
    );
  }
  return value;
}
