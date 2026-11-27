export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly build: readonly string[];
  readonly raw: string;
}

const MAX_SEMVER_LENGTH = 256;
const MAX_RANGE_LENGTH = 512;

function isNonNegativeInt(part: string): boolean {
  if (part.length === 0 || part.length > 15) return false;
  if (part.length > 1 && part.charCodeAt(0) === 48) return false; // no leading zero
  for (let i = 0; i < part.length; i += 1) {
    const code = part.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function isAllDigits(part: string): boolean {
  if (part.length === 0) return false;
  for (let i = 0; i < part.length; i += 1) {
    const code = part.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function isIdentChars(part: string): boolean {
  if (part.length === 0) return false;
  for (let i = 0; i < part.length; i += 1) {
    const c = part.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) || // 0-9
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122) || // a-z
      c === 45; // -
    if (!ok) return false;
  }
  return true;
}

function parsePrerelease(raw: string): readonly (string | number)[] | null {
  if (raw.length === 0) return null;
  const parts = raw.split('.');
  const out: (string | number)[] = [];
  for (const part of parts) {
    if (!isIdentChars(part)) return null;
    if (isAllDigits(part)) {
      if (part.length > 1 && part.charCodeAt(0) === 48) return null; // SemVer §9: no leading zero
      const num = Number(part);
      if (!Number.isSafeInteger(num)) return null;
      out.push(num);
    } else {
      out.push(part);
    }
  }
  return out;
}

function parseBuild(raw: string): readonly string[] | null {
  if (raw.length === 0) return null;
  const parts = raw.split('.');
  for (const part of parts) {
    if (!isIdentChars(part)) return null;
  }
  return parts;
}

export function parseSemVer(input: string): SemVer | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_SEMVER_LENGTH) {
    return null;
  }
  if (input.trim() !== input) return null;

  let coreAndPre = input;
  let build: readonly string[] = [];

  const plusIdx = input.indexOf('+');
  if (plusIdx !== -1) {
    coreAndPre = input.slice(0, plusIdx);
    const parsedBuild = parseBuild(input.slice(plusIdx + 1));
    if (parsedBuild === null) return null;
    build = parsedBuild;
  }

  let core = coreAndPre;
  let prerelease: readonly (string | number)[] = [];

  const dashIdx = coreAndPre.indexOf('-');
  if (dashIdx !== -1) {
    core = coreAndPre.slice(0, dashIdx);
    const parsedPre = parsePrerelease(coreAndPre.slice(dashIdx + 1));
    if (parsedPre === null) return null;
    prerelease = parsedPre;
  }

  const segments = core.split('.');
  if (segments.length !== 3) return null;

  const [majStr, minStr, patStr] = segments;
  if (
    majStr === undefined ||
    minStr === undefined ||
    patStr === undefined ||
    !isNonNegativeInt(majStr) ||
    !isNonNegativeInt(minStr) ||
    !isNonNegativeInt(patStr)
  ) {
    return null;
  }

  const major = Number(majStr);
  const minor = Number(minStr);
  const patch = Number(patStr);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }

  return { major, minor, patch, prerelease, build, raw: input };
}

export function isValidSemVer(input: string): boolean {
  return parseSemVer(input) !== null;
}

export function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  const aPre = a.prerelease;
  const bPre = b.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1; // normal > prerelease
  if (bPre.length === 0) return -1;

  const len = Math.min(aPre.length, bPre.length);
  for (let i = 0; i < len; i += 1) {
    const ai = aPre[i]!;
    const bi = bPre[i]!;
    if (ai === bi) continue;

    const aIsNum = typeof ai === 'number';
    const bIsNum = typeof bi === 'number';
    if (aIsNum && bIsNum) return ai < bi ? -1 : 1;
    if (aIsNum) return -1; // numeric < alphanumeric
    if (bIsNum) return 1;
    return ai < bi ? -1 : 1;
  }

  if (aPre.length !== bPre.length) {
    return aPre.length < bPre.length ? -1 : 1;
  }
  return 0;
}

type ComparatorOp = '=' | '>=' | '>' | '<=' | '<' | '*';

interface Comparator {
  readonly op: ComparatorOp;
  readonly version: SemVer;
}

interface PartialVersion {
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  readonly prerelease: readonly (string | number)[];
}

function isWildcardToken(token: string): boolean {
  return token === '*' || token === 'x' || token === 'X';
}

function makeVersion(
  major: number,
  minor: number,
  patch: number,
  prerelease: readonly (string | number)[] = [],
): SemVer {
  return {
    major,
    minor,
    patch,
    prerelease,
    build: [],
    raw: `${major}.${minor}.${patch}${prerelease.length > 0 ? `-${prerelease.join('.')}` : ''}`,
  };
}

function parsePartialVersion(raw: string): PartialVersion | null {
  if (raw.length === 0 || raw.length > MAX_SEMVER_LENGTH) return null;

  let coreAndPre = raw;
  const plusIdx = raw.indexOf('+');
  if (plusIdx !== -1) {
    coreAndPre = raw.slice(0, plusIdx);
    if (parseBuild(raw.slice(plusIdx + 1)) === null) return null;
  }

  let core = coreAndPre;
  let prerelease: readonly (string | number)[] = [];
  const dashIdx = coreAndPre.indexOf('-');
  if (dashIdx !== -1) {
    core = coreAndPre.slice(0, dashIdx);
    const parsedPre = parsePrerelease(coreAndPre.slice(dashIdx + 1));
    if (parsedPre === null) return null;
    prerelease = parsedPre;
  }

  const parts = core.split('.');
  if (parts.length < 1 || parts.length > 3) return null;

  const parsePart = (part: string | undefined): number | null | 'invalid' => {
    if (part === undefined) return null;
    if (isWildcardToken(part)) return null;
    if (!isNonNegativeInt(part)) return 'invalid';
    const num = Number(part);
    return Number.isSafeInteger(num) ? num : 'invalid';
  };

  const major = parsePart(parts[0]);
  const minor = parsePart(parts[1]);
  const patch = parsePart(parts[2]);
  if (major === 'invalid' || minor === 'invalid' || patch === 'invalid') return null;
  if (major === null && (minor !== null || patch !== null)) return null;
  if (minor === null && patch !== null) return null;
  if (prerelease.length > 0 && (major === null || minor === null || patch === null)) return null;

  return { major, minor, patch, prerelease };
}

function expandToken(token: string): readonly Comparator[] | null {
  if (token.length === 0) return null;

  if (isWildcardToken(token)) {
    return [{ op: '*', version: makeVersion(0, 0, 0) }];
  }

  if (token.startsWith('^')) {
    const p = parsePartialVersion(token.slice(1));
    if (p === null) return null;
    if (p.major === null) {
      return [{ op: '>=', version: makeVersion(0, 0, 0) }];
    }
    const lower = makeVersion(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease);
    let upper: SemVer;
    if (p.major > 0) {
      upper = makeVersion(p.major + 1, 0, 0, [0]);
    } else if (p.minor === null) {
      upper = makeVersion(1, 0, 0, [0]);
    } else if (p.minor > 0) {
      upper = makeVersion(0, p.minor + 1, 0, [0]);
    } else if (p.patch === null) {
      upper = makeVersion(0, 1, 0, [0]);
    } else {
      upper = makeVersion(0, 0, p.patch + 1, [0]);
    }
    return [
      { op: '>=', version: lower },
      { op: '<', version: upper },
    ];
  }

  if (token.startsWith('~')) {
    const p = parsePartialVersion(token.slice(1));
    if (p === null) return null;
    if (p.major === null) {
      return [{ op: '>=', version: makeVersion(0, 0, 0) }];
    }
    const lower = makeVersion(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease);
    const upper =
      p.minor === null
        ? makeVersion(p.major + 1, 0, 0, [0])
        : makeVersion(p.major, p.minor + 1, 0, [0]);
    return [
      { op: '>=', version: lower },
      { op: '<', version: upper },
    ];
  }

  let op: ComparatorOp | null = null;
  let rest = token;
  if (token.startsWith('>=')) {
    op = '>=';
    rest = token.slice(2);
  } else if (token.startsWith('<=')) {
    op = '<=';
    rest = token.slice(2);
  } else if (token.startsWith('>')) {
    op = '>';
    rest = token.slice(1);
  } else if (token.startsWith('<')) {
    op = '<';
    rest = token.slice(1);
  } else if (token.startsWith('=')) {
    op = '=';
    rest = token.slice(1);
  }

  const p = parsePartialVersion(rest);
  if (p === null) return null;

  if (op !== null) {
    if (p.major === null) return null;
    if (op === '=' && (p.minor === null || p.patch === null)) {
      // Treat =1.x or =1.2 as x-range
      const lower = makeVersion(p.major, p.minor ?? 0, 0);
      const upper =
        p.minor === null
          ? makeVersion(p.major + 1, 0, 0, [0])
          : makeVersion(p.major, p.minor + 1, 0, [0]);
      return [
        { op: '>=', version: lower },
        { op: '<', version: upper },
      ];
    }
    if (op === '<=' && (p.minor === null || p.patch === null)) {
      const upper =
        p.minor === null
          ? makeVersion(p.major + 1, 0, 0, [0])
          : makeVersion(p.major, p.minor + 1, 0, [0]);
      return [{ op: '<', version: upper }];
    }
    if (op === '>' && (p.minor === null || p.patch === null)) {
      const lower =
        p.minor === null
          ? makeVersion(p.major + 1, 0, 0)
          : makeVersion(p.major, p.minor + 1, 0);
      return [{ op: '>=', version: lower }];
    }
    return [{ op, version: makeVersion(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease) }];
  }

  // Bare version or X-range
  if (p.major === null) {
    return [{ op: '*', version: makeVersion(0, 0, 0) }];
  }
  if (p.minor === null) {
    return [
      { op: '>=', version: makeVersion(p.major, 0, 0) },
      { op: '<', version: makeVersion(p.major + 1, 0, 0, [0]) },
    ];
  }
  if (p.patch === null) {
    return [
      { op: '>=', version: makeVersion(p.major, p.minor, 0) },
      { op: '<', version: makeVersion(p.major, p.minor + 1, 0, [0]) },
    ];
  }
  return [{ op: '=', version: makeVersion(p.major, p.minor, p.patch, p.prerelease) }];
}

function parseComparatorSet(rawSet: string): readonly Comparator[] | null {
  const trimmed = rawSet.trim();
  if (trimmed.length === 0) return null;

  // Hyphen range: "A - B"
  const hyphenIdx = trimmed.indexOf(' - ');
  if (hyphenIdx !== -1) {
    const leftRaw = trimmed.slice(0, hyphenIdx).trim();
    const rightRaw = trimmed.slice(hyphenIdx + 3).trim();
    if (rightRaw.includes(' - ') || leftRaw.includes(' ') || rightRaw.includes(' ')) {
      return null;
    }
    const left = parsePartialVersion(leftRaw);
    const right = parsePartialVersion(rightRaw);
    if (left === null || right === null || left.major === null || right.major === null) {
      return null;
    }
    const lower: Comparator = {
      op: '>=',
      version: makeVersion(left.major, left.minor ?? 0, left.patch ?? 0, left.prerelease),
    };
    let upper: Comparator;
    if (right.minor === null) {
      upper = { op: '<', version: makeVersion(right.major + 1, 0, 0, [0]) };
    } else if (right.patch === null) {
      upper = { op: '<', version: makeVersion(right.major, right.minor + 1, 0, [0]) };
    } else {
      upper = {
        op: '<=',
        version: makeVersion(right.major, right.minor, right.patch, right.prerelease),
      };
    }
    return [lower, upper];
  }

  const tokens = trimmed.split(/\s+/);
  const comparators: Comparator[] = [];
  for (const token of tokens) {
    const expanded = expandToken(token);
    if (expanded === null) return null;
    comparators.push(...expanded);
  }
  return comparators.length > 0 ? comparators : null;
}

function parseRange(range: string): readonly (readonly Comparator[])[] | null {
  if (typeof range !== 'string' || range.length === 0 || range.length > MAX_RANGE_LENGTH) {
    return null;
  }
  const trimmed = range.trim();
  if (trimmed.length === 0) return null;

  const orParts = trimmed.split('||');
  const sets: (readonly Comparator[])[] = [];
  for (const part of orParts) {
    const parsed = parseComparatorSet(part);
    if (parsed === null) return null;
    sets.push(parsed);
  }
  return sets;
}

function matchesComparator(version: SemVer, comp: Comparator): boolean {
  if (comp.op === '*') return true;
  const cmp = compareSemVer(version, comp.version);
  switch (comp.op) {
    case '=':
      return cmp === 0;
    case '>=':
      return cmp >= 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    case '<':
      return cmp < 0;
  }
}

function matchesComparatorSet(version: SemVer, set: readonly Comparator[]): boolean {
  for (const comp of set) {
    if (!matchesComparator(version, comp)) return false;
  }

  // SemVer prerelease isolation rule: a prerelease version only satisfies a comparator set
  // if at least one comparator in that set specifies a prerelease on the same [major, minor, patch] tuple.
  if (version.prerelease.length > 0) {
    let allowed = false;
    for (const comp of set) {
      if (
        comp.op !== '*' &&
        comp.version.prerelease.length > 0 &&
        comp.version.major === version.major &&
        comp.version.minor === version.minor &&
        comp.version.patch === version.patch
      ) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return false;
  }

  return true;
}

export function isValidSemVerRange(range: string): boolean {
  return parseRange(range) !== null;
}

export function satisfiesRange(version: string, range: string): boolean {
  const parsedVersion = parseSemVer(version);
  if (parsedVersion === null) return false;
  const sets = parseRange(range);
  if (sets === null) return false;

  for (const set of sets) {
    if (matchesComparatorSet(parsedVersion, set)) {
      return true;
    }
  }
  return false;
}
