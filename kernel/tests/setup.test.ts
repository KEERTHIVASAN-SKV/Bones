/**
 * Setup validation (KER-002 / KER-003): proves Vitest, fast-check (seeded), and the
 * TypeScript pipeline work end to end.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createOpId, parseOpId } from '../src/index.js';

const SEEDED = { seed: 12345, numRuns: 100 } as const;

describe('Setup validation', () => {
  it('vitest runs', () => {
    expect(1 + 1).toBe(2);
  });

  it('fast-check runs with a fixed seed', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => n + 0 === n),
      SEEDED
    );
  });

  it('fast-check is reproducible: same seed generates the same values', () => {
    const sample = () => fc.sample(fc.integer(), { seed: 12345, numRuns: 20 });
    expect(sample()).toEqual(sample());
  });

  it('OpIdKey round-trips through createOpId / parseOpId', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1 }), (replicaId, seq) => {
        const parsed = parseOpId(createOpId(replicaId, seq));
        return parsed !== null && parsed.replicaId === replicaId && parsed.seq === seq;
      }),
      SEEDED
    );
  });
});
