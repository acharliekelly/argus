import { describe, expect, it } from 'vitest';
import {
  assertUpdateEligible,
  normalizeCoreInventory,
  normalizeExtensionInventory
} from '../src/wordpress/inventory.js';

describe('inventory normalization', () => {
  it('normalizes WP-CLI extension output', () => {
    expect(
      normalizeExtensionInventory([
        {
          name: 'akismet',
          status: 'active',
          version: '5.3',
          update: 'available',
          update_version: '5.4'
        }
      ])
    ).toEqual([
      {
        slug: 'akismet',
        status: 'active',
        version: '5.3',
        updateVersion: '5.4'
      }
    ]);
  });

  it('normalizes core inventory with no update', () => {
    expect(normalizeCoreInventory('7.0', [])).toEqual({
      version: '7.0',
      updateVersion: null
    });
  });

  it('rejects core mutation', () => {
    expect(() =>
      assertUpdateEligible(
        {
          core: { version: '7.0', updateVersion: '7.0.1' },
          plugins: [],
          themes: []
        },
        { type: 'core', slug: 'wordpress' }
      )
    ).toThrow(/unsupported_target/);
  });

  it('rejects a component without an available update', () => {
    expect(() =>
      assertUpdateEligible(
        {
          core: { version: '7.0', updateVersion: null },
          plugins: [
            { slug: 'hello-dolly', status: 'inactive', version: '1.7.2', updateVersion: null }
          ],
          themes: []
        },
        { type: 'plugin', slug: 'hello-dolly' }
      )
    ).toThrow(/no_update_available/);
  });
});
