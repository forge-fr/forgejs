import crypto from 'node:crypto';
import {
  ConflictError,
  createToken,
  ForbiddenError,
  NotFoundError,
  secret,
  UnauthorizedError,
} from '@forge-fr/core';
import {
  buildAuthorizationUrl,
  createApiKeyAuthStrategy,
  createApiKeyManager,
  createArgon2PasswordHasher,
  createJwtAuthStrategy,
  createJwtService,
  createMemoryApiKeyStore,
  createMemorySessionStore,
  createOAuthState,
  createPkceChallenge,
  createSessionAuthStrategy,
  createSessionManager,
  verifyOAuthCallbackState,
  type ApiKeyManager,
  type AuthIdentity,
  type AuthMiddlewareOptions,
  type JwtService,
  type PasswordHasher,
  type SessionManager,
} from '@forge-fr/auth';
import {
  actorFromIdentity,
  createAuthorizer,
  definePolicy,
  type Actor,
  type Authorizer,
} from '@forge-fr/authorization';
import type { PlaygroundStore } from '../store.ts';
import {
  TENANT_ACME_ID,
  toPublicUser,
  type PlaygroundAuthConfig,
  type PublicUser,
  type TaskRecord,
  type TenantRecord,
  type UserRecord,
  type UserRole,
} from '../types.ts';

export interface RegisterUserInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly tenantName?: string | undefined;
  readonly role: UserRole;
}

export interface LoginUserInput {
  readonly email: string;
  readonly password: string;
}

export interface AuthSessionResponse {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: '2h';
  readonly user: PublicUser;
  readonly tenant: TenantRecord | undefined;
  readonly permissions: readonly string[];
}

export interface AuthMeResponse {
  readonly identity: {
    readonly subject: string;
    readonly tenantId: string | null;
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
    readonly scopes: readonly string[];
    readonly method: string;
  };
  readonly user: PublicUser | null;
  readonly tenant: TenantRecord | null;
}

export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly tenantId: string;
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly createdAtMs: number;
  readonly expiresAtMs?: number;
  readonly revokedAtMs?: number;
}

export interface OAuthPkceDemoBundle {
  readonly stateId: string;
  readonly state: string;
  readonly nonce: string;
  readonly pkce: {
    readonly codeVerifier: string;
    readonly codeChallenge: string;
    readonly method: 'S256';
  };
  readonly authorizationUrl: string;
  readonly redirectUri: string;
}

export interface SessionCookieLoginResult {
  readonly setCookieHeader: string;
  readonly cookieName: string;
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly user: PublicUser;
  readonly tenant: TenantRecord | null;
}

export interface AuthService {
  readonly passwordHasher: PasswordHasher;
  readonly jwtService: JwtService;
  readonly apiKeyManager: ApiKeyManager;
  readonly sessionManager: SessionManager;
  readonly authorizer: Authorizer;
  readonly authMiddlewareOptions: AuthMiddlewareOptions;
  register(input: RegisterUserInput): Promise<AuthSessionResponse>;
  login(input: LoginUserInput): Promise<AuthSessionResponse>;
  me(identity: AuthIdentity): AuthMeResponse;
  listApiKeys(identity: AuthIdentity): readonly ApiKeySummary[];
  createApiKey(
    identity: AuthIdentity,
    input: { readonly name: string; readonly scopes: readonly string[]; readonly expiresInSeconds?: number },
  ): Promise<{ readonly apiKey: string; readonly key: ApiKeySummary }>;
  revokeApiKey(identity: AuthIdentity, id: string): Promise<ApiKeySummary>;
  createCookieSession(identity: AuthIdentity): Promise<SessionCookieLoginResult>;
  clearCookieSession(rawSessionId?: string): Promise<string>;
  generateOAuthPkce(
    identity: AuthIdentity,
    input: { readonly redirectUri: string; readonly scopes: readonly string[] },
  ): Promise<OAuthPkceDemoBundle>;
  verifyOAuthState(stateId: string, receivedState: string): { readonly verified: true; readonly state: string };
  verifySseToken(rawToken: string): Promise<{ readonly tenantId: string; readonly actorName: string }>;
  resolveActorName(identity: AuthIdentity): string;
  resetEphemeralAuthState(): void;
}

export const AuthServiceToken = createToken<AuthService>('playground:AuthService');

const ALLOWED_OAUTH_REDIRECT_URIS = [
  'http://localhost:3000/playground',
  'https://playground.forgejs.dev/callback',
] as const;

function resolveJwtSecret(explicitSecret?: string): ReturnType<typeof secret<string>> {
  const fromEnv = typeof process !== 'undefined' ? process.env['PLAYGROUND_JWT_SECRET']?.trim() : undefined;
  const configured = explicitSecret?.trim() || fromEnv;
  if (configured && Buffer.byteLength(configured, 'utf8') >= 32) {
    return secret(configured);
  }
  return secret(crypto.randomBytes(32).toString('hex'));
}

export function getRolePermissions(role: UserRole): readonly string[] {
  if (role === 'admin') {
    return [
      'tasks:read',
      'tasks:create',
      'tasks:update',
      'tasks:delete',
      'attachments:read',
      'attachments:write',
      'attachments:delete',
      'webhooks:read',
      'webhooks:write',
      'webhooks:delete',
      'webhooks:replay',
      'sandbox:reset',
    ];
  }
  return [
    'tasks:read',
    'tasks:create',
    'tasks:update:own',
    'tasks:delete:own',
    'attachments:read',
    'attachments:write',
    'webhooks:read',
  ];
}

export function toActor(identity: AuthIdentity): Actor {
  const base = actorFromIdentity(identity);
  if (identity.method === 'api_key') {
    return Object.freeze({
      ...base,
      permissions: base.permissions.length > 0 ? base.permissions : base.scopes,
    });
  }
  return base;
}

export function createAuthService(
  store: PlaygroundStore,
  config: PlaygroundAuthConfig = {},
): AuthService {
  const passwordHasher =
    config.passwordHasher ??
    createArgon2PasswordHasher({
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

  const jwtService = createJwtService({
    algorithms: ['HS256'],
    secret: resolveJwtSecret(config.jwtSecret),
    issuer: 'forgejs-live-playground',
    audience: 'forgejs-live-playground-api',
    defaultExpiresIn: '2h',
  });

  let apiKeyStore = createMemoryApiKeyStore();
  const delegatingApiKeyStore = {
    get: (id: string) => apiKeyStore.get(id),
    set: (id: string, record: Parameters<typeof apiKeyStore.set>[1]) => apiKeyStore.set(id, record),
    revoke: (id: string, revokedAtMs: number) => apiKeyStore.revoke(id, revokedAtMs),
  };
  const apiKeyManager = createApiKeyManager({
    store: delegatingApiKeyStore,
    prefix: 'fjs_key',
  });
  const apiKeySummaries = new Map<string, ApiKeySummary>();

  let sessionStore = createMemorySessionStore();
  const delegatingSessionStore = {
    get: (idHash: string) => sessionStore.get(idHash),
    set: (idHash: string, record: Parameters<typeof sessionStore.set>[1]) => sessionStore.set(idHash, record),
    delete: (idHash: string) => sessionStore.delete(idHash),
    deleteBySubject: (subject: string) =>
      sessionStore.deleteBySubject ? sessionStore.deleteBySubject(subject) : Promise.resolve(),
  };
  const sessionManager = createSessionManager({
    store: delegatingSessionStore,
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 86_400,
    cookie: {
      name: 'forge_session',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      partitioned: true,
    },
  });

  const pendingOAuthStates = new Map<string, { readonly state: string; readonly tenantId: string }>();

  const jwtStrategy = createJwtAuthStrategy(jwtService);
  const apiKeyStrategy = createApiKeyAuthStrategy(apiKeyManager, { headerName: 'x-api-key' });
  const sessionStrategy = createSessionAuthStrategy(sessionManager);

  const authorizer = createAuthorizer({
    enforceTenantIsolation: true,
    roles: {
      admin: { permissions: [...getRolePermissions('admin')] },
      member: { permissions: [...getRolePermissions('member')] },
    },
    policies: [
      definePolicy<TaskRecord>({
        name: 'task:mutate-own-or-admin',
        actions: ['tasks:mutate'],
        effect: 'allow',
        condition: ({ actor, resource }) => {
          if (!resource) return false;
          if (actor.tenantId !== resource.tenantId) return false;
          return actor.roles.includes('admin') || resource.createdBy === actor.subject;
        },
      }),
    ],
  });

  const authMiddlewareOptions: AuthMiddlewareOptions = {
    strategies: [jwtStrategy, apiKeyStrategy, sessionStrategy],
  };

  async function issueTokenForUser(user: Pick<UserRecord, 'id' | 'tenantId' | 'email' | 'name' | 'role'>): Promise<string> {
    return jwtService.sign(
      {
        tenantId: user.tenantId,
        email: user.email,
        name: user.name,
        roles: [user.role],
        permissions: [...getRolePermissions(user.role)],
      },
      { subject: user.id },
    );
  }

  return {
    passwordHasher,
    jwtService,
    apiKeyManager,
    sessionManager,
    authorizer,
    authMiddlewareOptions,

    async register(input: RegisterUserInput): Promise<AuthSessionResponse> {
      const emailLower = input.email.trim().toLowerCase();
      if (store.getUserByEmail(emailLower)) {
        throw new ConflictError(`An account with email "${emailLower}" already exists`);
      }

      let tenantId = TENANT_ACME_ID;
      if (input.tenantName && input.tenantName.trim().length > 0) {
        const slug = input.tenantName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        tenantId = store.generateId('tenant');
        store.tenants.set(tenantId, {
          id: tenantId,
          slug: slug || tenantId,
          name: input.tenantName.trim(),
          plan: 'starter',
          createdAt: new Date().toISOString(),
        });
      }

      const passwordHash = await passwordHasher.hash(input.password);
      const user: UserRecord = {
        id: store.generateId('user'),
        tenantId,
        email: emailLower,
        name: input.name,
        role: input.role,
        passwordHash,
        createdAt: new Date().toISOString(),
      };
      store.addUser(user);

      const accessToken = await issueTokenForUser(user);
      const tenant = store.getTenant(user.tenantId);

      return {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: '2h',
        user: toPublicUser(user),
        tenant,
        permissions: getRolePermissions(user.role),
      };
    },

    async login(input: LoginUserInput): Promise<AuthSessionResponse> {
      const user = store.getUserByEmail(input.email);
      if (!user) {
        throw new UnauthorizedError('Invalid email or password');
      }
      const valid = await passwordHasher.verify(input.password, user.passwordHash);
      if (!valid) {
        throw new UnauthorizedError('Invalid email or password');
      }

      const accessToken = await issueTokenForUser(user);
      const tenant = store.getTenant(user.tenantId);

      return {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: '2h',
        user: toPublicUser(user),
        tenant,
        permissions: getRolePermissions(user.role),
      };
    },

    me(identity: AuthIdentity): AuthMeResponse {
      const user = store.users.get(identity.subject);
      const tenant = identity.tenantId ? store.getTenant(identity.tenantId) : undefined;
      const effectivePerms =
        identity.method === 'api_key' && identity.permissions.length === 0
          ? identity.scopes
          : identity.permissions;
      return {
        identity: {
          subject: identity.subject,
          tenantId: identity.tenantId ?? null,
          roles: identity.roles,
          permissions: effectivePerms,
          scopes: identity.scopes,
          method: identity.method,
        },
        user: user ? toPublicUser(user) : null,
        tenant: tenant ?? null,
      };
    },

    listApiKeys(identity: AuthIdentity): readonly ApiKeySummary[] {
      const tenantId = identity.tenantId;
      if (!tenantId) {
        throw new ForbiddenError('Tenant context required');
      }
      return Array.from(apiKeySummaries.values())
        .filter((k) => k.tenantId === tenantId)
        .sort((a, b) => b.createdAtMs - a.createdAtMs);
    },

    async createApiKey(identity, input) {
      const tenantId = identity.tenantId;
      if (!tenantId) {
        throw new ForbiddenError('Tenant context required');
      }
      const actorName = this.resolveActorName(identity);
      const issued = await apiKeyManager.create({
        subject: identity.subject,
        name: input.name,
        tenantId,
        scopes: input.scopes,
        ...(input.expiresInSeconds !== undefined ? { expiresInSeconds: input.expiresInSeconds } : {}),
        metadata: { name: actorName },
      });
      const summary: ApiKeySummary = {
        id: issued.record.id,
        name: issued.record.name,
        prefix: issued.record.prefix,
        tenantId,
        subject: issued.record.subject,
        scopes: issued.record.scopes,
        createdAtMs: issued.record.createdAtMs,
        ...(issued.record.expiresAtMs !== undefined ? { expiresAtMs: issued.record.expiresAtMs } : {}),
      };
      apiKeySummaries.set(summary.id, summary);
      return { apiKey: issued.apiKey, key: summary };
    },

    async revokeApiKey(identity, id) {
      const tenantId = identity.tenantId;
      if (!tenantId) {
        throw new ForbiddenError('Tenant context required');
      }
      const existing = apiKeySummaries.get(id);
      if (!existing) {
        throw new NotFoundError(`API key "${id}" not found`);
      }
      if (existing.tenantId !== tenantId) {
        throw new ForbiddenError('Cannot revoke API key belonging to another tenant');
      }
      await apiKeyManager.revoke(id);
      const updated: ApiKeySummary = {
        ...existing,
        revokedAtMs: Date.now(),
      };
      apiKeySummaries.set(id, updated);
      return updated;
    },

    async createCookieSession(identity) {
      const user = store.users.get(identity.subject);
      if (!user) {
        throw new UnauthorizedError('Active user record required to mint session cookie');
      }
      const tenant = store.getTenant(user.tenantId) ?? null;
      const result = await sessionManager.create(user.id, {
        tenantId: user.tenantId,
        roles: [user.role],
        permissions: [...getRolePermissions(user.role)],
        data: { email: user.email, name: user.name },
      });
      return {
        setCookieHeader: result.setCookieHeader,
        cookieName: sessionManager.cookieName,
        sessionToken: result.sessionId,
        expiresAt: new Date(result.record.expiresAtMs).toISOString(),
        user: toPublicUser(user),
        tenant,
      };
    },

    async clearCookieSession(rawSessionId?: string): Promise<string> {
      if (rawSessionId) {
        await sessionManager.revoke(rawSessionId);
      }
      return sessionManager.clearCookieHeader();
    },

    async generateOAuthPkce(identity, input) {
      const tenantId = identity.tenantId ?? TENANT_ACME_ID;
      const pkce = await createPkceChallenge();
      const oauthState = createOAuthState();
      const authorizationUrl = buildAuthorizationUrl({
        authorizationEndpoint: 'https://auth.forgejs.example/oauth/authorize',
        clientId: 'forgejs-playground-web',
        redirectUri: input.redirectUri,
        allowedRedirectUris: [...ALLOWED_OAUTH_REDIRECT_URIS],
        state: oauthState.state,
        nonce: oauthState.nonce,
        scopes: input.scopes,
        pkce,
      });
      const stateId = store.generateId('oauth_st');
      pendingOAuthStates.set(stateId, { state: oauthState.state, tenantId });
      return {
        stateId,
        state: oauthState.state,
        nonce: oauthState.nonce,
        pkce,
        authorizationUrl,
        redirectUri: input.redirectUri,
      };
    },

    verifyOAuthState(stateId, receivedState) {
      const stored = pendingOAuthStates.get(stateId);
      if (!stored) {
        throw new UnauthorizedError('OAuth state bundle expired or not generated');
      }
      verifyOAuthCallbackState(stored.state, receivedState);
      return { verified: true, state: stored.state };
    },

    async verifySseToken(rawToken: string): Promise<{ readonly tenantId: string; readonly actorName: string }> {
      const verified = await jwtService.verify(rawToken);
      const tenantId =
        typeof verified.payload['tenantId'] === 'string' ? verified.payload['tenantId'] : null;
      if (!tenantId) {
        throw new ForbiddenError('Token missing tenantId claim');
      }
      const actorName =
        typeof verified.payload['name'] === 'string'
          ? verified.payload['name']
          : String(verified.payload.sub ?? 'user');
      return { tenantId, actorName };
    },

    resolveActorName(identity: AuthIdentity): string {
      const claimName = identity.claims['name'];
      if (typeof claimName === 'string' && claimName.length > 0) return claimName;
      const user = store.users.get(identity.subject);
      return user?.name ?? identity.subject;
    },

    resetEphemeralAuthState(): void {
      apiKeyStore = createMemoryApiKeyStore();
      apiKeySummaries.clear();
      sessionStore = createMemorySessionStore();
      pendingOAuthStates.clear();
    },
  };
}
