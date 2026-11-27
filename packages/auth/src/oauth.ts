import {
  createRemoteJWKSet,
  jwtVerify,
  type CryptoKey as JoseCryptoKey,
  type JWTPayload,
  type KeyObject as JoseKeyObject,
} from 'jose';
import { ConfigurationError, UnauthorizedError } from '@forge-fr/core';
import { constantTimeEqual, generateSecureToken, sha256Base64Url } from './crypto.js';

export interface PkceChallenge {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly method: 'S256';
}

export interface OAuthStateBundle {
  readonly state: string;
  readonly nonce: string;
}

export interface BuildAuthorizationUrlOptions {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly allowedRedirectUris: readonly string[];
  readonly state: string;
  readonly scopes?: readonly string[];
  readonly nonce?: string;
  readonly pkce?: PkceChallenge;
  readonly extraParams?: Readonly<Record<string, string>>;
}

export type OidcAsymmetricAlgorithm =
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

const ALLOWED_OIDC_ALGS = new Set<string>([
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

export interface VerifyOidcIdTokenOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly algorithms: readonly OidcAsymmetricAlgorithm[];
  readonly key?: JoseCryptoKey | JoseKeyObject | Uint8Array;
  readonly jwksUrl?: string;
  readonly expectedNonce?: string;
  readonly clockToleranceSeconds?: number;
}

export interface VerifiedOidcIdToken {
  readonly subject: string;
  readonly claims: JWTPayload;
}

function isAllowedAuthUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') {
    return true;
  }
  if (
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return true;
  }
  return false;
}

export async function createPkceChallenge(): Promise<PkceChallenge> {
  const codeVerifier = generateSecureToken(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  return Object.freeze({
    codeVerifier,
    codeChallenge,
    method: 'S256' as const,
  });
}

export function createOAuthState(): OAuthStateBundle {
  return Object.freeze({
    state: generateSecureToken(32),
    nonce: generateSecureToken(32),
  });
}

export function buildAuthorizationUrl(options: BuildAuthorizationUrlOptions): string {
  if (!isAllowedAuthUrl(options.authorizationEndpoint)) {
    throw new ConfigurationError(
      'OAuth authorizationEndpoint must be a valid https:// URL (or localhost http:// for local dev)',
    );
  }
  if (!isAllowedAuthUrl(options.redirectUri)) {
    throw new ConfigurationError(
      'OAuth redirectUri must be a valid https:// URL (or localhost http:// for local dev)',
    );
  }
  if (!options.allowedRedirectUris.includes(options.redirectUri)) {
    throw new ConfigurationError('OAuth redirectUri is not in the configured allowedRedirectUris list');
  }
  if (options.clientId.trim().length === 0) {
    throw new ConfigurationError('OAuth clientId must be a non-empty string');
  }
  if (options.state.trim().length < 16) {
    throw new ConfigurationError('OAuth state must be a high-entropy token (>= 16 chars)');
  }

  const url = new URL(options.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);

  if (options.scopes !== undefined && options.scopes.length > 0) {
    url.searchParams.set('scope', options.scopes.join(' '));
  }
  if (options.nonce !== undefined) {
    url.searchParams.set('nonce', options.nonce);
  }
  if (options.pkce !== undefined) {
    url.searchParams.set('code_challenge', options.pkce.codeChallenge);
    url.searchParams.set('code_challenge_method', options.pkce.method);
  }
  if (options.extraParams !== undefined) {
    for (const [key, val] of Object.entries(options.extraParams)) {
      if (
        key !== 'client_id' &&
        key !== 'redirect_uri' &&
        key !== 'response_type' &&
        key !== 'state' &&
        key !== 'code_challenge' &&
        key !== 'code_challenge_method'
      ) {
        url.searchParams.set(key, val);
      }
    }
  }

  return url.toString();
}

export function verifyOAuthCallbackState(expectedState: string, receivedState: string | null): void {
  if (
    typeof expectedState !== 'string' ||
    expectedState.length < 16 ||
    typeof receivedState !== 'string' ||
    !constantTimeEqual(expectedState, receivedState)
  ) {
    throw new UnauthorizedError('Invalid OAuth callback state parameter');
  }
}

export async function verifyOidcIdToken(
  idToken: string,
  options: VerifyOidcIdTokenOptions,
): Promise<VerifiedOidcIdToken> {
  if (!Array.isArray(options.algorithms) || options.algorithms.length === 0) {
    throw new ConfigurationError('OIDC verification requires a non-empty asymmetric algorithms allowlist');
  }
  for (const alg of options.algorithms) {
    if (!ALLOWED_OIDC_ALGS.has(alg)) {
      throw new ConfigurationError(`Unsupported OIDC ID token algorithm "${String(alg)}"`);
    }
  }
  if (options.key === undefined && options.jwksUrl === undefined) {
    throw new ConfigurationError('OIDC verification requires either key or jwksUrl');
  }

  const verifyOpts = {
    issuer: options.issuer,
    audience: options.clientId,
    algorithms: [...options.algorithms],
    clockTolerance: options.clockToleranceSeconds ?? 5,
  };

  let payload: JWTPayload;
  try {
    const result =
      options.jwksUrl !== undefined
        ? await jwtVerify(idToken, createRemoteJWKSet(new URL(options.jwksUrl)), verifyOpts)
        : await jwtVerify(idToken, options.key!, verifyOpts);
    payload = result.payload;
  } catch {
    throw new UnauthorizedError('Invalid or expired OIDC ID token');
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new UnauthorizedError('OIDC ID token missing sub claim');
  }

  if (options.expectedNonce !== undefined) {
    const tokenNonce = typeof payload['nonce'] === 'string' ? payload['nonce'] : '';
    if (!constantTimeEqual(options.expectedNonce, tokenNonce)) {
      throw new UnauthorizedError('OIDC ID token nonce mismatch');
    }
  }

  return Object.freeze({
    subject: payload.sub,
    claims: payload,
  });
}
