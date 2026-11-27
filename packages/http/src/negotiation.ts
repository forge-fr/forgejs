export interface AcceptMediaRange {
  readonly type: string;
  readonly mainType: string;
  readonly subType: string;
  readonly q: number;
  readonly specificity: number;
  readonly order: number;
}

function parseMediaType(raw: string): { mainType: string; subType: string } | null {
  const trimmed = raw.trim().toLowerCase();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) {
    return null;
  }
  const mainType = trimmed.slice(0, slashIdx).trim();
  const subType = trimmed.slice(slashIdx + 1).trim();
  if (mainType.length === 0 || subType.length === 0 || subType.includes('/')) {
    return null;
  }
  return { mainType, subType };
}

export function parseAcceptHeader(header: string | null | undefined): readonly AcceptMediaRange[] {
  if (!header || header.trim().length === 0) {
    return [
      {
        type: '*/*',
        mainType: '*',
        subType: '*',
        q: 1,
        specificity: 0,
        order: 0,
      },
    ];
  }

  const parts = header.split(',');
  const ranges: AcceptMediaRange[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const rawPart = parts[i]?.trim();
    if (!rawPart) continue;

    const segments = rawPart.split(';');
    const mediaPart = segments[0];
    if (!mediaPart) continue;

    const parsedType = parseMediaType(mediaPart);
    if (!parsedType) continue;

    let q = 1;
    let extraParams = 0;
    let invalidQ = false;

    for (let j = 1; j < segments.length; j += 1) {
      const param = segments[j]?.trim();
      if (!param) continue;
      const eqIdx = param.indexOf('=');
      if (eqIdx === -1) continue;
      const key = param.slice(0, eqIdx).trim().toLowerCase();
      const val = param.slice(eqIdx + 1).trim();
      if (key === 'q') {
        const parsedQ = Number(val);
        if (!Number.isFinite(parsedQ) || parsedQ < 0 || parsedQ > 1) {
          invalidQ = true;
          break;
        }
        q = parsedQ;
      } else {
        extraParams += 1;
      }
    }

    if (invalidQ || q === 0) continue;

    const baseSpecificity =
      parsedType.mainType === '*'
        ? 0
        : parsedType.subType === '*'
          ? 1
          : 2;

    ranges.push({
      type: `${parsedType.mainType}/${parsedType.subType}`,
      mainType: parsedType.mainType,
      subType: parsedType.subType,
      q,
      specificity: baseSpecificity * 10 + extraParams,
      order: i,
    });
  }

  ranges.sort((a, b) => {
    if (b.q !== a.q) return b.q - a.q;
    if (b.specificity !== a.specificity) return b.specificity - a.specificity;
    return a.order - b.order;
  });

  return ranges;
}

export function negotiateContentType(
  acceptHeader: string | null | undefined,
  offered: readonly string[],
): string | null {
  if (offered.length === 0) {
    return null;
  }

  const ranges = parseAcceptHeader(acceptHeader);
  if (ranges.length === 0) {
    return null;
  }

  let bestOffered: string | null = null;
  let bestQ = -1;
  let bestSpecificity = -1;
  let bestRangeOrder = Number.MAX_SAFE_INTEGER;
  let bestOfferedOrder = Number.MAX_SAFE_INTEGER;

  for (let offeredIdx = 0; offeredIdx < offered.length; offeredIdx += 1) {
    const candidate = offered[offeredIdx];
    if (!candidate) continue;
    const parsedCandidate = parseMediaType(candidate);
    if (!parsedCandidate) continue;

    // Find the most specific matching media range for this candidate (RFC 9110 §12.5.1)
    let matchedRange: AcceptMediaRange | null = null;
    for (const range of ranges) {
      const mainMatches = range.mainType === '*' || range.mainType === parsedCandidate.mainType;
      const subMatches = range.subType === '*' || range.subType === parsedCandidate.subType;
      if (!mainMatches || !subMatches) continue;

      if (
        matchedRange === null ||
        range.specificity > matchedRange.specificity ||
        (range.specificity === matchedRange.specificity && range.q > matchedRange.q)
      ) {
        matchedRange = range;
      }
    }

    if (!matchedRange) continue;

    const isBetter =
      matchedRange.q > bestQ ||
      (matchedRange.q === bestQ && matchedRange.specificity > bestSpecificity) ||
      (matchedRange.q === bestQ &&
        matchedRange.specificity === bestSpecificity &&
        matchedRange.order < bestRangeOrder) ||
      (matchedRange.q === bestQ &&
        matchedRange.specificity === bestSpecificity &&
        matchedRange.order === bestRangeOrder &&
        offeredIdx < bestOfferedOrder);

    if (isBetter) {
      bestOffered = candidate;
      bestQ = matchedRange.q;
      bestSpecificity = matchedRange.specificity;
      bestRangeOrder = matchedRange.order;
      bestOfferedOrder = offeredIdx;
    }
  }

  return bestOffered;
}
