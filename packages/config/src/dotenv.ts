const FORBIDDEN_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ParseDotEnvOptions {
  /** Expand `${VAR}` and `${VAR:-default}` references using already-parsed keys and `baseEnv`. Default: `false`. */
  readonly expand?: boolean;
  /** Optional base environment used when resolving `${VAR}` placeholders with `expand: true`. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

function unescapeDoubleQuoted(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]!;
      if (next === 'n') {
        out += '\n';
      } else if (next === 'r') {
        out += '\r';
      } else if (next === 't') {
        out += '\t';
      } else if (next === '"' || next === '\\' || next === '$') {
        out += next;
      } else {
        out += `\\${next}`;
      }
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

function expandReferences(
  value: string,
  parsed: Readonly<Record<string, string>>,
  baseEnv?: Readonly<Record<string, string | undefined>>,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g,
    (_full, name: string, fallback?: string) => {
      const resolved = parsed[name] ?? baseEnv?.[name];
      if (resolved !== undefined && resolved.length > 0) {
        return resolved;
      }
      return fallback ?? '';
    },
  );
}

/**
 * Pure, runtime-agnostic `.env` parser supporting comments, `export KEY=VALUE`,
 * single/double/backtick quotes, multiline quoted values, and optional `${VAR}` expansion.
 */
export function parseDotEnv(
  content: string,
  options: ParseDotEnvOptions = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const len = normalized.length;
  let pos = 0;

  while (pos < len) {
    // Skip leading whitespace and empty lines
    while (pos < len && (normalized[pos] === ' ' || normalized[pos] === '\t' || normalized[pos] === '\n')) {
      pos += 1;
    }
    if (pos >= len) {
      break;
    }

    // Comment line
    if (normalized[pos] === '#') {
      const nl = normalized.indexOf('\n', pos);
      pos = nl === -1 ? len : nl + 1;
      continue;
    }

    // Optional `export ` prefix
    if (
      normalized.startsWith('export', pos) &&
      (normalized[pos + 6] === ' ' || normalized[pos + 6] === '\t')
    ) {
      pos += 6;
      while (pos < len && (normalized[pos] === ' ' || normalized[pos] === '\t')) {
        pos += 1;
      }
    }

    // Parse key up to `=` or `\n`
    const eqIdx = normalized.indexOf('=', pos);
    const nlIdx = normalized.indexOf('\n', pos);
    if (eqIdx === -1 || (nlIdx !== -1 && nlIdx < eqIdx)) {
      pos = nlIdx === -1 ? len : nlIdx + 1;
      continue;
    }

    const rawKey = normalized.slice(pos, eqIdx).trim();
    pos = eqIdx + 1;

    // Skip spaces/tabs immediately after `=`
    while (pos < len && (normalized[pos] === ' ' || normalized[pos] === '\t')) {
      pos += 1;
    }

    let value = '';
    let allowExpand = options.expand === true;
    const firstChar = normalized[pos];

    if (firstChar === '"' || firstChar === "'" || firstChar === '`') {
      const quote = firstChar;
      if (quote === "'") {
        allowExpand = false;
      }
      pos += 1;
      const startVal = pos;
      let closed = false;
      while (pos < len) {
        const ch = normalized[pos]!;
        if (quote === '"' && ch === '\\' && pos + 1 < len) {
          pos += 2;
          continue;
        }
        if (ch === quote) {
          value = normalized.slice(startVal, pos);
          pos += 1;
          closed = true;
          break;
        }
        pos += 1;
      }
      if (!closed) {
        value = normalized.slice(startVal);
      }
      if (quote === '"') {
        value = unescapeDoubleQuoted(value);
      }
      // Advance to end of line
      const endLine = normalized.indexOf('\n', pos);
      pos = endLine === -1 ? len : endLine + 1;
    } else {
      const endLine = normalized.indexOf('\n', pos);
      const rawLine = endLine === -1 ? normalized.slice(pos) : normalized.slice(pos, endLine);
      pos = endLine === -1 ? len : endLine + 1;

      // Strip inline comment preceded by whitespace
      const commentIdx = rawLine.search(/\s+#/);
      value = (commentIdx === -1 ? rawLine : rawLine.slice(0, commentIdx)).trim();
    }

    if (rawKey.length === 0 || FORBIDDEN_ENV_KEYS.has(rawKey) || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(rawKey)) {
      continue;
    }

    if (allowExpand) {
      value = expandReferences(value, result, options.baseEnv);
    }

    result[rawKey] = value;
  }

  return result;
}
