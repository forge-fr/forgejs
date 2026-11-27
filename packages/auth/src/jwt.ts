import {
  SignJWT,
  createRemoteJWKSet,
  jwtVerify,
  type CryptoKey as JoseCryptoKey,
  type JWTPayload,
  type JWTVerifyOptions,
  type KeyObject as JoseKeyObject,
} from 'jose';
import {
  ConfigurationError,
  UnauthorizedError,
  isSecretValue,
  type SecretValue,
} from '@forge-fr/core';
import type { ForgeContext } from '@forge-fr/http';
import { createAuthIdentity, type AuthIdentity, type AuthStrategy } from './types.js';

export type JwtAlgorithm =
  | 'HS256'
  | 'HS384'
  | 'HS512'
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'EdDSA';

const ALLOWED_JWT_ALGORITHMS = new Set<string>([
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
  'EdDSA',
]);

const SYMMETRIC_ALGORITHMS = new Set<string>(['HS256', 'HS384', 'HS512']);
const MIN_HMAC_SECRET_BYTES = 32;
const TEXT_ENCODER = new TextEncoder();

export interface JwtServiceOptions {
  /** Mandatory explicit algorithm allowlist; 'none' is always rejected. */
  readonly algorithms: readonly JwtAlgorithm[];
  /** Shared HMAC secret (>= 32 bytes) for HS256/HS384/HS512. */
  readonly secret?: string | Uint8Array | SecretValue<string>;
  /** Private signing key for asymmetric algorithms (RS*, ES*, PS*, EdDSA). */
  readonly signingKey?: JoseCryptoKey | JoseKeyObject | Uint8Array;
  /** Public verification key for asymmetric algorithms. */
  readonly verificationKey?: JoseCryptoKey | JoseKeyObject | Uint8Array;
  /** Remote JWKS URL for asymmetric verification. */
  readonly jwksUrl?: string;
  readonly issuer?: string | readonly string[];
  readonly audience?: string | readonly string[];
  readonly defaultExpiresIn?: string | number;
  readonly clockToleranceSeconds?: number;
}

export interface JwtSignOptions {
  readonly algorithm?: JwtAlgorithm;
  readonly expiresIn?: string | number;
  readonly subject?: string;
  readonly jwtId?: string;
  readonly issuer?: string;
  readonly audience?: string | readonly string[];
  readonly keyId?: string;
}

export interface JwtVerifyResult<TClaims extends Record<string, unknown> = Record<string, unknown>> {
  readonly payload: JWTPayload & TClaims;
  readonly protectedHeader: {
    readonly alg: string;
    readonly kid?: string;
    readonly typ?: string;
  };
}

export interface JwtService {
  sign(payload: Record<string, unknown>, options?: JwtSignOptions): Promise<string>;
  verify<TClaims extends Record<string, unknown> = Record<string, unknown>>(
    token: string,
  ): Promise<JwtVerifyResult<TClaims>>;
}

function resolveSymmetricSecret(
  rawSecret: string | Uint8Array | SecretValue<string>,
): Uint8Array {
  let bytes: Uint8Array;
  if (rawSecret instanceof Uint8Array) {
    bytes = rawSecret;
  } else if (isSecretValue(rawSecret)) {
    bytes = TEXT_ENCODER.encode(String(rawSecret.reveal()));
  } else if (typeof rawSecret === 'string') {
    bytes = TEXT_ENCODER.encode(rawSecret);
  } else {
    throw new ConfigurationError('JWT secret must be a string, Uint8Array, or SecretValue');
  }

  if (bytes.byteLength < MIN_HMAC_SECRET_BYTES) {
    throw new ConfigurationError(
      `HMAC JWT secret must be at least ${MIN_HMAC_SECRET_BYTES} bytes (256 bits)`,
    );
  }
  return bytes;
}

export function createJwtService(options: JwtServiceOptions): JwtService {
  if (!Array.isArray(options.algorithms) || options.algorithms.length === 0) {
    throw new ConfigurationError('JWT service requires a non-empty explicit algorithms allowlist');
  }

  for (const alg of options.algorithms) {
    if (typeof alg !== 'string' || !ALLOWED_JWT_ALGORITHMS.has(alg)) {
      throw new ConfigurationError(`Unsupported or forbidden JWT algorithm "${String(alg)}"`);
    }
  }

  const usesSymmetric = options.algorithms.some((a) => SYMMETRIC_ALGORITHMS.has(a));
  const usesAsymmetric = options.algorithms.some((a) => !SYMMETRIC_ALGORITHMS.has(a));
  if (usesSymmetric && usesAsymmetric) {
    throw new ConfigurationError(
      'Cannot mix symmetric (HS*) and asymmetric JWT algorithms in the same verifier to prevent key confusion',
    );
  }

  let signingMaterial: JoseCryptoKey | JoseKeyObject | Uint8Array | undefined;
  let verifyKey: JoseCryptoKey | JoseKeyObject | Uint8Array | undefined;
  let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  if (usesSymmetric) {
    if (options.secret === undefined) {
      throw new ConfigurationError('HMAC JWT algorithms require a secret of at least 32 bytes');
    }
    const secretBytes = resolveSymmetricSecret(options.secret);
    signingMaterial = secretBytes;
    verifyKey = secretBytes;
  } else {
    signingMaterial = options.signingKey;
    verifyKey = options.verificationKey;
    if (options.jwksUrl !== undefined) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(options.jwksUrl);
      } catch {
        throw new ConfigurationError('Invalid jwksUrl provided to JWT service');
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        throw new ConfigurationError('jwksUrl must use https:// or http://');
      }
      remoteJwks = createRemoteJWKSet(parsedUrl);
    }
    if (verifyKey === undefined && remoteJwks === undefined) {
      throw new ConfigurationError(
        'Asymmetric JWT service requires either verificationKey or jwksUrl',
      );
    }
  }

  const defaultAlgorithm = options.algorithms[0]!;
  const defaultExpiresIn = options.defaultExpiresIn ?? '15m';
  const clockTolerance = options.clockToleranceSeconds ?? 5;

  return {
    async sign(payload: Record<string, unknown>, signOptions: JwtSignOptions = {}): Promise<string> {
      if (signingMaterial === undefined) {
        throw new ConfigurationError('JWT service is configured for verification only (no signingKey)');
      }

      const alg = signOptions.algorithm ?? defaultAlgorithm;
      if (!options.algorithms.includes(alg)) {
        throw new ConfigurationError(
          `Requested signing algorithm "${alg}" is not in configured algorithms allowlist`,
        );
      }

      const builder = new SignJWT(payload)
        .setProtectedHeader({
          alg,
          typ: 'JWT',
          ...(signOptions.keyId !== undefined ? { kid: signOptions.keyId } : {}),
        })
        .setIssuedAt()
        .setExpirationTime(signOptions.expiresIn ?? defaultExpiresIn);

      const issuer =
        signOptions.issuer ??
        (typeof options.issuer === 'string' ? options.issuer : options.issuer?.[0]);
      if (issuer !== undefined) {
        builder.setIssuer(issuer);
      }

      const audience = signOptions.audience ?? options.audience;
      if (audience !== undefined) {
        builder.setAudience(
          typeof audience === 'string' ? audience : [...audience],
        );
      }

      if (signOptions.subject !== undefined) {
        builder.setSubject(signOptions.subject);
      }
      if (signOptions.jwtId !== undefined) {
        builder.setJti(signOptions.jwtId);
      }

      return builder.sign(signingMaterial);
    },

    async verify<TClaims extends Record<string, unknown> = Record<string, unknown>>(
      token: string,
    ): Promise<JwtVerifyResult<TClaims>> {
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new UnauthorizedError('Missing or empty bearer token');
      }

      const verifyOpts: JWTVerifyOptions = {
        algorithms: [...options.algorithms],
        clockTolerance,
        ...(options.issuer !== undefined
          ? {
              issuer:
                typeof options.issuer === 'string' ? options.issuer : [...options.issuer],
            }
          : {}),
        ...(options.audience !== undefined
          ? {
              audience:
                typeof options.audience === 'string' ? options.audience : [...options.audience],
            }
          : {}),
      };

      try {
        const result =
          remoteJwks !== undefined
            ? await jwtVerify(token, remoteJwks, verifyOpts)
            : await jwtVerify(token, verifyKey!, verifyOpts);

        const alg = result.protectedHeader.alg;
        if (typeof alg !== 'string' || !options.algorithms.includes(alg as JwtAlgorithm)) {
          throw new UnauthorizedError('Invalid token signature algorithm');
        }

        return Object.freeze({
          payload: result.payload as JWTPayload & TClaims,
          protectedHeader: Object.freeze({
            alg,
            ...(typeof result.protectedHeader.kid === 'string'
              ? { kid: result.protectedHeader.kid }
              : {}),
            ...(typeof result.protectedHeader.typ === 'string'
              ? { typ: result.protectedHeader.typ }
              : {}),
          }),
        });
      } catch (err: unknown) {
        if (err instanceof UnauthorizedError) {
          throw err;
        }
        throw new UnauthorizedError('Invalid or expired authentication token');
      }
    },
  };
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export interface JwtAuthStrategyOptions {
  readonly name?: string;
  readonly mapIdentity?: (payload: JWTPayload) => AuthIdentity;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim().split(/\s+/);
  }
  return [];
}

export function createJwtAuthStrategy(
  jwtService: JwtService,
  options: JwtAuthStrategyOptions = {},
): AuthStrategy {
  return {
    name: options.name ?? 'jwt',
    async authenticate(ctx: ForgeContext): Promise<AuthIdentity | null> {
      const token = extractBearerToken(ctx.request);
      if (token === null) {
        return null;
      }

      const verified = await jwtService.verify(token);
      if (options.mapIdentity !== undefined) {
        return options.mapIdentity(verified.payload);
      }

      const sub = verified.payload.sub;
      if (typeof sub !== 'string' || sub.length === 0) {
        throw new UnauthorizedError('Authentication token is missing subject claim');
      }

      const raw = verified.payload as Record<string, unknown>;
      const tenantId = typeof raw['tenantId'] === 'string' ? raw['tenantId'] : undefined;

      return createAuthIdentity({
        subject: sub,
        method: 'jwt',
        ...(tenantId !== undefined ? { tenantId } : {}),
        roles: readStringArray(raw['roles']),
        permissions: readStringArray(raw['permissions']),
        scopes: readStringArray(raw['scope'] ?? raw['scopes']),
        claims: raw,
      });
    },
  };
}
