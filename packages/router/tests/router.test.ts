import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  HTTP_METHODS,
  RouterError,
  createRouter,
  type HttpMethod,
} from '../src/index.js';

describe('@forge-fr/router — Radix-Tree HTTP Router', () => {
  it('matches all standard HTTP methods and root/static paths with query stripping and trailing-slash normalization', () => {
    const router = createRouter<string>();

    router.get('/', 'root');
    router.get('/users', 'list-users');
    router.post('/users', 'create-user');
    router.put('/users/profile', 'replace-profile');
    router.patch('/users/profile', 'patch-profile');
    router.delete('/users/profile', 'delete-profile');
    router.options('/users', 'options-users');
    router.head('/health', 'head-health');

    const rootMatch = router.match('GET', '/');
    expect(rootMatch.kind).toBe('found');
    if (rootMatch.kind === 'found') {
      expect(rootMatch.route.handler).toBe('root');
      expect(rootMatch.params).toEqual({});
    }

    const withQueryAndSlash = router.match('GET', '/users/?page=2&limit=10#top');
    expect(withQueryAndSlash.kind).toBe('found');
    if (withQueryAndSlash.kind === 'found') {
      expect(withQueryAndSlash.route.handler).toBe('list-users');
    }

    const postMatch = router.match('POST', '/users');
    expect(postMatch.kind).toBe('found');
    if (postMatch.kind === 'found') {
      expect(postMatch.route.handler).toBe('create-user');
    }

    const methods: Array<[HttpMethod, string, string]> = [
      ['PUT', '/users/profile', 'replace-profile'],
      ['PATCH', '/users/profile', 'patch-profile'],
      ['DELETE', '/users/profile', 'delete-profile'],
      ['OPTIONS', '/users', 'options-users'],
      ['HEAD', '/health', 'head-health'],
    ];
    for (const [method, path, expected] of methods) {
      const m = router.match(method, path);
      expect(m.kind).toBe('found');
      if (m.kind === 'found') {
        expect(m.route.handler).toBe(expected);
      }
    }

    // Automatic HEAD fallback to GET when HEAD is not explicitly registered
    const autoHead = router.match('HEAD', '/users');
    expect(autoHead.kind).toBe('found');
    if (autoHead.kind === 'found') {
      expect(autoHead.route.handler).toBe('list-users');
      expect(autoHead.matchedMethod).toBe('GET');
    }
  });

  it('enforces deterministic precedence: static > constrained param > dynamic param > wildcard', () => {
    const router = createRouter<string>();

    router.get('/files/*filepath', 'wildcard');
    router.get('/files/:bucket', 'param');
    router.get('/files/:id{\\d+}', 'numeric-constrained');
    router.get('/files/latest', 'static');

    const mStatic = router.match('GET', '/files/latest');
    expect(mStatic.kind === 'found' && mStatic.route.handler).toBe('static');

    const mConstrained = router.match('GET', '/files/4096');
    expect(mConstrained.kind === 'found' && mConstrained.route.handler).toBe('numeric-constrained');
    if (mConstrained.kind === 'found') {
      expect(mConstrained.params).toEqual({ id: '4096' });
    }

    const mParam = router.match('GET', '/files/avatars');
    expect(mParam.kind === 'found' && mParam.route.handler).toBe('param');
    if (mParam.kind === 'found') {
      expect(mParam.params).toEqual({ bucket: 'avatars' });
    }

    const mWildcard = router.match('GET', '/files/avatars/2026/photo%201.png');
    expect(mWildcard.kind === 'found' && mWildcard.route.handler).toBe('wildcard');
    if (mWildcard.kind === 'found') {
      expect(mWildcard.params).toEqual({ filepath: 'avatars/2026/photo 1.png' });
    }
  });

  it('backtracks accurately across sibling branches and supports distinct parameter names per route', () => {
    const router = createRouter<string>();

    router.get('/orgs/:orgId/members/:memberId', 'org-member');
    router.get('/orgs/:slug/settings', 'org-settings');
    router.get('/orgs/*rest', 'org-fallback');

    const m1 = router.match('GET', '/orgs/acme/members/u-7');
    expect(m1.kind).toBe('found');
    if (m1.kind === 'found') {
      expect(m1.route.handler).toBe('org-member');
      expect(m1.params).toEqual({ orgId: 'acme', memberId: 'u-7' });
    }

    const m2 = router.match('GET', '/orgs/acme/settings');
    expect(m2.kind).toBe('found');
    if (m2.kind === 'found') {
      expect(m2.route.handler).toBe('org-settings');
      expect(m2.params).toEqual({ slug: 'acme' });
    }

    const m3 = router.match('GET', '/orgs/acme/unknown/deep');
    expect(m3.kind).toBe('found');
    if (m3.kind === 'found') {
      expect(m3.route.handler).toBe('org-fallback');
      expect(m3.params).toEqual({ rest: 'acme/unknown/deep' });
    }
  });

  it('supports function constraints via route options', () => {
    const router = createRouter<string>();
    const isUuid = (val: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}$/i.test(val);

    router.get('/orders/:id', 'order-by-uuid', {
      constraints: { id: isUuid },
    });
    router.get('/orders/:code', 'order-by-code');

    const uuidMatch = router.match('GET', '/orders/1234abcd-ef01');
    expect(uuidMatch.kind === 'found' && uuidMatch.route.handler).toBe('order-by-uuid');

    const codeMatch = router.match('GET', '/orders/ORD-99');
    expect(codeMatch.kind === 'found' && codeMatch.route.handler).toBe('order-by-code');
  });

  it('composes nested route groups with prefixes, middleware chains, and metadata', () => {
    const router = createRouter<string, string>();

    router.group(
      '/api',
      (api) => {
        api.group(
          '/v1',
          (v1) => {
            v1.get('/users/:id', 'get-user', {
              middleware: ['validate-id'],
              meta: { auth: true, scope: 'users:read' },
              name: 'v1.users.get',
            });
          },
          {
            middleware: ['rate-limit'],
            meta: { version: 'v1' },
          },
        );
      },
      {
        middleware: ['cors', 'request-id'],
        meta: { surface: 'public-api' },
      },
    );

    const matched = router.match('GET', '/api/v1/users/u42');
    expect(matched.kind).toBe('found');
    if (matched.kind === 'found') {
      expect(matched.route.path).toBe('/api/v1/users/:id');
      expect(matched.route.name).toBe('v1.users.get');
      expect(matched.route.middleware).toEqual(['cors', 'request-id', 'rate-limit', 'validate-id']);
      expect(matched.route.meta).toEqual({
        surface: 'public-api',
        version: 'v1',
        auth: true,
        scope: 'users:read',
      });
      expect(matched.params).toEqual({ id: 'u42' });
    }

    expect(router.routes()).toHaveLength(1);
  });

  it('returns accurate 404 not_found and 405 method_not_allowed with RFC sorted Allow header', () => {
    const router = createRouter<string>();
    router.post('/items/:id', 'update-item');
    router.get('/items/:id', 'get-item');
    router.delete('/items/:id', 'delete-item');

    const notFound = router.match('GET', '/does/not/exist');
    expect(notFound).toEqual({ kind: 'not_found' });

    const notAllowed = router.match('PUT', '/items/99');
    expect(notAllowed.kind).toBe('method_not_allowed');
    if (notAllowed.kind === 'method_not_allowed') {
      // GET implies HEAD when autoHead is enabled
      expect(notAllowed.allowedMethods).toEqual(['DELETE', 'GET', 'HEAD', 'POST']);
      expect(notAllowed.allowHeader).toBe('DELETE, GET, HEAD, POST');
    }
  });

  it('registers all HTTP methods via all() and respects ignoreTrailingSlash: false', () => {
    const strictRouter = createRouter<string>({ ignoreTrailingSlash: false });
    strictRouter.all('/ping', 'pong');

    for (const method of HTTP_METHODS) {
      const m = strictRouter.match(method, '/ping');
      expect(m.kind === 'found' && m.route.handler).toBe('pong');
    }

    expect(strictRouter.match('GET', '/ping/').kind).toBe('not_found');
  });

  it('rejects duplicate routes, misplaced wildcards, and invalid parameter syntax', () => {
    const router = createRouter<string>();
    router.get('/users/:id', 'first');

    expect(() => router.get('/users/:id', 'second')).toThrow(RouterError);
    expect(() => router.get('/users/:userId', 'ambiguous-duplicate')).toThrow(RouterError);
    expect(() => router.get('/files/*path/more', 'mid-wildcard')).toThrow(RouterError);
    expect(() => router.get('/users/:', 'empty-param')).toThrow(RouterError);
    expect(() => router.get('/users/:id/posts/:id', 'dup-param-name')).toThrow(RouterError);
  });

  it('SECURITY: rejects prototype-pollution param names, returns null-prototype params, and handles malformed URI encoding safely', () => {
    const router = createRouter<string>();

    expect(() => router.get('/bad/:__proto__', 'x')).toThrow(RouterError);
    expect(() => router.get('/bad/:constructor', 'x')).toThrow(RouterError);
    expect(() => router.get('/bad/:prototype', 'x')).toThrow(RouterError);
    expect(() => router.get('/bad/*__proto__', 'x')).toThrow(RouterError);

    router.get('/users/:name', 'user-by-name');

    const ok = router.match('GET', '/users/alice%20smith');
    expect(ok.kind).toBe('found');
    if (ok.kind === 'found') {
      expect(Object.getPrototypeOf(ok.params)).toBeNull();
      expect(ok.params['name']).toBe('alice smith');
    }

    // Malformed percent encoding must never throw uncaught URIError
    expect(() => router.match('GET', '/users/%E0%A4%A')).not.toThrow();
    expect(router.match('GET', '/users/%E0%A4%A')).toEqual({ kind: 'not_found' });

    // Encoded traversal or special segments do not pollute Object.prototype
    const protoAttempt = router.match('GET', '/users/__proto__');
    expect(protoAttempt.kind).toBe('found');
    expect(({} as Record<string, unknown>)['name']).toBeUndefined();
  });

  it('SECURITY (property-based): handles arbitrary random URLs safely without crashes or prototype pollution', () => {
    const router = createRouter<string>();
    router.get('/', 'root');
    router.get('/api/users/:id{\\d+}', 'user-num');
    router.get('/api/users/:slug', 'user-slug');
    router.post('/api/items/:id', 'item-post');
    router.get('/assets/*path', 'assets');

    fc.assert(
      fc.property(
        fc.constantFrom(...HTTP_METHODS),
        fc.string({ minLength: 0, maxLength: 80 }),
        (method, rawPath) => {
          const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
          const res = router.match(method, path);
          expect(['found', 'not_found', 'method_not_allowed']).toContain(res.kind);
          if (res.kind === 'found') {
            expect(Object.getPrototypeOf(res.params)).toBeNull();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
