import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareSemVer,
  isValidSemVer,
  isValidSemVerRange,
  parseSemVer,
  satisfiesRange,
} from '../src/semver.js';

describe('@forge-fr/core SemVer 2.0.0 engine', () => {
  it('parses valid SemVer 2.0.0 strings and rejects malformed inputs', () => {
    const parsed = parseSemVer('1.2.3-alpha.1+build.42');
    expect(parsed).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['alpha', 1],
      build: ['build', '42'],
      raw: '1.2.3-alpha.1+build.42',
    });

    expect(isValidSemVer('0.1.0')).toBe(true);
    expect(isValidSemVer('2.0.0-rc.1')).toBe(true);
    expect(isValidSemVer('1.0.0+20130313144700')).toBe(true);

    // Invalid SemVer inputs per SemVer 2.0.0 spec
    expect(parseSemVer('')).toBeNull();
    expect(parseSemVer('1.2')).toBeNull();
    expect(parseSemVer('v1.2.3')).toBeNull();
    expect(parseSemVer('01.2.3')).toBeNull();
    expect(parseSemVer('1.02.3')).toBeNull();
    expect(parseSemVer('1.2.03')).toBeNull();
    expect(parseSemVer('1.2.3-01')).toBeNull();
    expect(parseSemVer('1.2.3-')).toBeNull();
    expect(parseSemVer('1.2.3+')).toBeNull();
    expect(parseSemVer('1.2.3.4')).toBeNull();
    expect(parseSemVer('a'.repeat(500))).toBeNull();
  });

  it('orders versions strictly according to SemVer 2.0.0 precedence', () => {
    const ordered = [
      '0.0.1',
      '0.1.0',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];

    for (let i = 0; i < ordered.length; i += 1) {
      const a = parseSemVer(ordered[i]!)!;
      expect(compareSemVer(a, a)).toBe(0);
      for (let j = i + 1; j < ordered.length; j += 1) {
        const b = parseSemVer(ordered[j]!)!;
        expect(compareSemVer(a, b)).toBe(-1);
        expect(compareSemVer(b, a)).toBe(1);
      }
    }

    // Build metadata MUST be ignored for precedence
    const b1 = parseSemVer('1.0.0+build.1')!;
    const b2 = parseSemVer('1.0.0+build.999')!;
    expect(compareSemVer(b1, b2)).toBe(0);
  });

  it('evaluates caret, tilde, comparators, wildcards, hyphen, AND/OR, and prerelease rules', () => {
    // Wildcards & exact
    expect(satisfiesRange('0.1.0', '*')).toBe(true);
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.4', '=1.2.3')).toBe(false);
    expect(satisfiesRange('1.9.5', '1.x')).toBe(true);
    expect(satisfiesRange('2.0.0', '1.x')).toBe(false);
    expect(satisfiesRange('1.2.9', '1.2.x')).toBe(true);
    expect(satisfiesRange('1.3.0', '1.2.x')).toBe(false);

    // Caret ranges (0.x & 0.0.x rules)
    expect(satisfiesRange('1.9.9', '^1.2.3')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfiesRange('1.2.2', '^1.2.3')).toBe(false);
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesRange('0.1.5', '^0.1.0')).toBe(true);
    expect(satisfiesRange('0.2.0', '^0.1.0')).toBe(false);
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false);

    // Tilde ranges
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfiesRange('1.9.0', '~1')).toBe(true);
    expect(satisfiesRange('2.0.0', '~1')).toBe(false);

    // Compound AND + OR + hyphen
    expect(satisfiesRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfiesRange('3.2.0', '^1.0.0 || ^3.0.0')).toBe(true);
    expect(satisfiesRange('2.1.0', '^1.0.0 || ^3.0.0')).toBe(false);
    expect(satisfiesRange('1.5.0', '1.2.0 - 2.3.4')).toBe(true);
    expect(satisfiesRange('2.3.5', '1.2.0 - 2.3.4')).toBe(false);

    // Prerelease opt-in isolation
    expect(satisfiesRange('1.2.3-alpha.1', '^1.0.0')).toBe(false);
    expect(satisfiesRange('2.0.0-alpha.1', '^1.0.0')).toBe(false);
    expect(satisfiesRange('1.2.3-alpha.2', '^1.2.3-alpha.1')).toBe(true);
    expect(satisfiesRange('1.2.3-alpha.0', '^1.2.3-alpha.1')).toBe(false);

    // Range validation
    expect(isValidSemVerRange('^0.1.0')).toBe(true);
    expect(isValidSemVerRange('>=0.1.0 <1.0.0 || ^2.0.0')).toBe(true);
    expect(isValidSemVerRange('')).toBe(false);
    expect(isValidSemVerRange('   ')).toBe(false);
    expect(isValidSemVerRange('not-a-range')).toBe(false);
    expect(isValidSemVerRange('^1.0.0 || ')).toBe(false);
    expect(isValidSemVerRange('>=1.2.3.4')).toBe(false);
  });

  it('fuzzes SemVer comparator ordering and parser safety without throwing', () => {
    const semverArb = fc.tuple(
      fc.integer({ min: 0, max: 20 }),
      fc.integer({ min: 0, max: 20 }),
      fc.integer({ min: 0, max: 20 }),
    );

    fc.assert(
      fc.property(semverArb, semverArb, ([ma1, mi1, pa1], [ma2, mi2, pa2]) => {
        const a = parseSemVer(`${ma1}.${mi1}.${pa1}`)!;
        const b = parseSemVer(`${ma2}.${mi2}.${pa2}`)!;
        const cmpAB = compareSemVer(a, b);
        const cmpBA = compareSemVer(b, a);
        expect(cmpAB).toBe(-cmpBA === 0 ? 0 : -cmpBA);
      }),
      { numRuns: 100 },
    );

    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.string({ maxLength: 80 }), (v, r) => {
        expect(() => parseSemVer(v)).not.toThrow();
        expect(() => isValidSemVerRange(r)).not.toThrow();
        expect(() => satisfiesRange(v, r)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
