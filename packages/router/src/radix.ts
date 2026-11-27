import {
  safeDecodeSegment,
  safeDecodeWildcard,
  type ParsedRoutePath,
} from './path.js';
import {
  RouterError,
  type HttpMethod,
  type RegisteredRoute,
} from './types.js';

export interface StoredHandler<THandler, TMiddleware> {
  readonly route: RegisteredRoute<THandler, TMiddleware>;
  readonly paramNames: readonly string[];
}

interface ConstrainedBranch<THandler, TMiddleware> {
  readonly key: string;
  readonly test: (value: string) => boolean;
  readonly node: RadixNode<THandler, TMiddleware>;
}

export class RadixNode<THandler, TMiddleware> {
  public readonly staticChildren = new Map<string, RadixNode<THandler, TMiddleware>>();
  public readonly constrainedChildren: ConstrainedBranch<THandler, TMiddleware>[] = [];
  public paramChild: RadixNode<THandler, TMiddleware> | undefined;
  public wildcardChild: RadixNode<THandler, TMiddleware> | undefined;
  public readonly handlers = new Map<HttpMethod, StoredHandler<THandler, TMiddleware>>();
}

export interface RadixHit<THandler, TMiddleware> {
  readonly stored: StoredHandler<THandler, TMiddleware>;
  readonly matchedMethod: HttpMethod;
  readonly params: Readonly<Record<string, string>>;
}

export class RadixTree<THandler, TMiddleware> {
  private readonly root = new RadixNode<THandler, TMiddleware>();
  private readonly registeredSignatures = new Set<string>();

  public insert(
    parsed: ParsedRoutePath,
    route: RegisteredRoute<THandler, TMiddleware>,
  ): void {
    const duplicateKey = `${route.method} ${parsed.signature}`;
    if (this.registeredSignatures.has(duplicateKey)) {
      throw new RouterError(
        'DUPLICATE_ROUTE',
        `Route "${route.method} ${route.path}" conflicts with an already registered route`,
      );
    }

    let current = this.root;
    for (const seg of parsed.segments) {
      if (seg.kind === 'static') {
        let next = current.staticChildren.get(seg.value);
        if (!next) {
          next = new RadixNode<THandler, TMiddleware>();
          current.staticChildren.set(seg.value, next);
        }
        current = next;
      } else if (seg.kind === 'constrained') {
        let branch = current.constrainedChildren.find((c) => c.key === seg.key);
        if (!branch) {
          branch = {
            key: seg.key,
            test: seg.test,
            node: new RadixNode<THandler, TMiddleware>(),
          };
          current.constrainedChildren.push(branch);
        }
        current = branch.node;
      } else if (seg.kind === 'param') {
        if (!current.paramChild) {
          current.paramChild = new RadixNode<THandler, TMiddleware>();
        }
        current = current.paramChild;
      } else {
        if (!current.wildcardChild) {
          current.wildcardChild = new RadixNode<THandler, TMiddleware>();
        }
        current = current.wildcardChild;
      }
    }

    this.registeredSignatures.add(duplicateKey);
    current.handlers.set(route.method, {
      route,
      paramNames: parsed.paramNames,
    });
  }

  public findMatch(
    method: HttpMethod,
    segments: readonly string[],
    autoHead: boolean,
  ): RadixHit<THandler, TMiddleware> | undefined {
    const captures: string[] = [];
    const hit = this.searchMethod(this.root, segments, 0, method, autoHead, captures);
    if (!hit) {
      return undefined;
    }

    const params = Object.create(null) as Record<string, string>;
    for (let i = 0; i < hit.stored.paramNames.length; i += 1) {
      const name = hit.stored.paramNames[i];
      const value = captures[i];
      if (name !== undefined && value !== undefined) {
        params[name] = value;
      }
    }
    return {
      stored: hit.stored,
      matchedMethod: hit.matchedMethod,
      params,
    };
  }

  private readonly scratchCaptures: string[] = [];
  private lastMatchedMethod: HttpMethod = 'GET';

  public findMatchFromString(
    method: HttpMethod,
    pathname: string,
    autoHead: boolean,
  ): RadixHit<THandler, TMiddleware> | undefined {
    if (pathname === '/') {
      const leaf = this.resolveLeafHandlerFast(this.root, method, autoHead);
      if (!leaf) return undefined;
      return {
        stored: leaf,
        matchedMethod: this.lastMatchedMethod,
        params: Object.create(null) as Record<string, string>,
      };
    }

    const captures = this.scratchCaptures;
    captures.length = 0;
    const stored = this.searchMethodString(this.root, pathname, 1, method, autoHead, captures);
    if (!stored) {
      return undefined;
    }

    const params = Object.create(null) as Record<string, string>;
    const paramNames = stored.paramNames;
    for (let i = 0; i < paramNames.length; i += 1) {
      const name = paramNames[i];
      const value = captures[i];
      if (name !== undefined && value !== undefined) {
        params[name] = value;
      }
    }
    captures.length = 0;
    return {
      stored,
      matchedMethod: this.lastMatchedMethod,
      params,
    };
  }

  public collectAllowedMethods(
    segments: readonly string[],
    autoHead: boolean,
  ): readonly HttpMethod[] {
    const allowed = new Set<HttpMethod>();
    this.collectMethods(this.root, segments, 0, allowed);
    if (allowed.size === 0) {
      return [];
    }
    if (autoHead && allowed.has('GET')) {
      allowed.add('HEAD');
    }
    return Array.from(allowed).sort();
  }

  public collectAllowedMethodsFromString(
    pathname: string,
    autoHead: boolean,
  ): readonly HttpMethod[] {
    if (pathname === '/') {
      if (this.root.handlers.size === 0) return [];
      const allowed = new Set<HttpMethod>(this.root.handlers.keys());
      if (autoHead && allowed.has('GET')) allowed.add('HEAD');
      return Array.from(allowed).sort();
    }
    const allowed: Set<HttpMethod> | null = this.collectMethodsString(
      this.root,
      pathname,
      1,
      null,
    );
    if (allowed === null || allowed.size === 0) {
      return [];
    }
    if (autoHead && allowed.has('GET')) {
      allowed.add('HEAD');
    }
    return Array.from(allowed).sort();
  }

  private resolveLeafHandlerFast(
    node: RadixNode<THandler, TMiddleware>,
    method: HttpMethod,
    autoHead: boolean,
  ): StoredHandler<THandler, TMiddleware> | undefined {
    const direct = node.handlers.get(method);
    if (direct !== undefined) {
      this.lastMatchedMethod = method;
      return direct;
    }
    if (method === 'HEAD' && autoHead) {
      const getFallback = node.handlers.get('GET');
      if (getFallback !== undefined) {
        this.lastMatchedMethod = 'GET';
        return getFallback;
      }
    }
    return undefined;
  }

  private resolveLeafHandler(
    node: RadixNode<THandler, TMiddleware>,
    method: HttpMethod,
    autoHead: boolean,
  ): { stored: StoredHandler<THandler, TMiddleware>; matchedMethod: HttpMethod } | undefined {
    const direct = node.handlers.get(method);
    if (direct !== undefined) {
      return { stored: direct, matchedMethod: method };
    }
    if (method === 'HEAD' && autoHead) {
      const getFallback = node.handlers.get('GET');
      if (getFallback !== undefined) {
        return { stored: getFallback, matchedMethod: 'GET' };
      }
    }
    return undefined;
  }

  private searchMethodString(
    node: RadixNode<THandler, TMiddleware>,
    pathname: string,
    pos: number,
    method: HttpMethod,
    autoHead: boolean,
    captures: string[],
  ): StoredHandler<THandler, TMiddleware> | undefined {
    const len = pathname.length;
    if (pos > len) {
      return this.resolveLeafHandlerFast(node, method, autoHead);
    }

    const slashIdx = pathname.indexOf('/', pos);
    const nextPos = slashIdx === -1 ? len + 1 : slashIdx + 1;
    const rawSegment = slashIdx === -1 ? pathname.slice(pos) : pathname.slice(pos, slashIdx);

    // 1. Static segment (highest precedence, O(1) lookup)
    if (node.staticChildren.size > 0) {
      const staticChild = node.staticChildren.get(rawSegment);
      if (staticChild !== undefined) {
        const staticHit = this.searchMethodString(
          staticChild,
          pathname,
          nextPos,
          method,
          autoHead,
          captures,
        );
        if (staticHit !== undefined) {
          return staticHit;
        }
      }
    }

    // 2 & 3. Constrained and unconstrained parameter branches
    if (rawSegment.length > 0 && (node.constrainedChildren.length > 0 || node.paramChild !== undefined)) {
      const decoded = rawSegment.indexOf('%') === -1 ? rawSegment : safeDecodeSegment(rawSegment);
      if (decoded !== undefined) {
        for (let i = 0; i < node.constrainedChildren.length; i += 1) {
          const branch = node.constrainedChildren[i]!;
          if (branch.test(decoded)) {
            captures.push(decoded);
            const constrainedHit = this.searchMethodString(
              branch.node,
              pathname,
              nextPos,
              method,
              autoHead,
              captures,
            );
            if (constrainedHit !== undefined) {
              return constrainedHit;
            }
            captures.pop();
          }
        }

        if (node.paramChild !== undefined) {
          captures.push(decoded);
          const paramHit = this.searchMethodString(
            node.paramChild,
            pathname,
            nextPos,
            method,
            autoHead,
            captures,
          );
          if (paramHit !== undefined) {
            return paramHit;
          }
          captures.pop();
        }
      }
    }

    // 4. Wildcard catch-all tail (lowest precedence)
    if (node.wildcardChild !== undefined) {
      const tailSlice = pathname.slice(pos);
      const tailSegments = tailSlice.length === 0 ? [''] : tailSlice.split('/');
      const decodedTail = safeDecodeWildcard(tailSegments);
      if (decodedTail !== undefined) {
        const wildcardLeaf = this.resolveLeafHandlerFast(node.wildcardChild, method, autoHead);
        if (wildcardLeaf !== undefined) {
          captures.push(decodedTail);
          return wildcardLeaf;
        }
      }
    }

    return undefined;
  }

  private collectMethodsString(
    node: RadixNode<THandler, TMiddleware>,
    pathname: string,
    pos: number,
    allowed: Set<HttpMethod> | null,
  ): Set<HttpMethod> | null {
    const len = pathname.length;
    if (pos > len) {
      if (node.handlers.size === 0) return allowed;
      const target = allowed ?? new Set<HttpMethod>();
      for (const method of node.handlers.keys()) {
        target.add(method);
      }
      return target;
    }

    const slashIdx = pathname.indexOf('/', pos);
    const nextPos = slashIdx === -1 ? len + 1 : slashIdx + 1;
    const rawSegment = slashIdx === -1 ? pathname.slice(pos) : pathname.slice(pos, slashIdx);

    let result = allowed;
    if (node.staticChildren.size > 0) {
      const staticChild = node.staticChildren.get(rawSegment);
      if (staticChild !== undefined) {
        result = this.collectMethodsString(staticChild, pathname, nextPos, result);
      }
    }

    if (rawSegment.length > 0 && (node.constrainedChildren.length > 0 || node.paramChild !== undefined)) {
      const decoded = rawSegment.indexOf('%') === -1 ? rawSegment : safeDecodeSegment(rawSegment);
      if (decoded !== undefined) {
        for (let i = 0; i < node.constrainedChildren.length; i += 1) {
          const branch = node.constrainedChildren[i]!;
          if (branch.test(decoded)) {
            result = this.collectMethodsString(branch.node, pathname, nextPos, result);
          }
        }
        if (node.paramChild !== undefined) {
          result = this.collectMethodsString(node.paramChild, pathname, nextPos, result);
        }
      }
    }

    if (node.wildcardChild !== undefined && node.wildcardChild.handlers.size > 0) {
      const tailSlice = pathname.slice(pos);
      const tailSegments = tailSlice.length === 0 ? [''] : tailSlice.split('/');
      const decodedTail = safeDecodeWildcard(tailSegments);
      if (decodedTail !== undefined) {
        const target = result ?? new Set<HttpMethod>();
        for (const method of node.wildcardChild.handlers.keys()) {
          target.add(method);
        }
        result = target;
      }
    }

    return result;
  }

  private searchMethod(
    node: RadixNode<THandler, TMiddleware>,
    segments: readonly string[],
    index: number,
    method: HttpMethod,
    autoHead: boolean,
    captures: string[],
  ): { stored: StoredHandler<THandler, TMiddleware>; matchedMethod: HttpMethod } | undefined {
    if (index === segments.length) {
      return this.resolveLeafHandler(node, method, autoHead);
    }

    const rawSegment = segments[index] ?? '';

    // 1. Static segment (highest precedence, O(1) lookup)
    const staticChild = node.staticChildren.get(rawSegment);
    if (staticChild !== undefined) {
      const staticHit = this.searchMethod(
        staticChild,
        segments,
        index + 1,
        method,
        autoHead,
        captures,
      );
      if (staticHit !== undefined) {
        return staticHit;
      }
    }

    // Decode once for dynamic/constrained segments; invalid percent sequences cannot match
    if (rawSegment.length > 0) {
      const decoded = safeDecodeSegment(rawSegment);
      if (decoded !== undefined) {
        // 2. Constrained parameter branches
        for (const branch of node.constrainedChildren) {
          if (branch.test(decoded)) {
            captures.push(decoded);
            const constrainedHit = this.searchMethod(
              branch.node,
              segments,
              index + 1,
              method,
              autoHead,
              captures,
            );
            if (constrainedHit !== undefined) {
              return constrainedHit;
            }
            captures.pop();
          }
        }

        // 3. Unconstrained parameter branch
        if (node.paramChild !== undefined) {
          captures.push(decoded);
          const paramHit = this.searchMethod(
            node.paramChild,
            segments,
            index + 1,
            method,
            autoHead,
            captures,
          );
          if (paramHit !== undefined) {
            return paramHit;
          }
          captures.pop();
        }
      }
    }

    // 4. Wildcard catch-all tail (lowest precedence)
    if (node.wildcardChild !== undefined) {
      const decodedTail = safeDecodeWildcard(segments.slice(index));
      if (decodedTail !== undefined) {
        const wildcardLeaf = this.resolveLeafHandler(node.wildcardChild, method, autoHead);
        if (wildcardLeaf !== undefined) {
          captures.push(decodedTail);
          return wildcardLeaf;
        }
      }
    }

    return undefined;
  }

  private collectMethods(
    node: RadixNode<THandler, TMiddleware>,
    segments: readonly string[],
    index: number,
    allowed: Set<HttpMethod>,
  ): void {
    if (index === segments.length) {
      for (const method of node.handlers.keys()) {
        allowed.add(method);
      }
      return;
    }

    const rawSegment = segments[index] ?? '';

    const staticChild = node.staticChildren.get(rawSegment);
    if (staticChild !== undefined) {
      this.collectMethods(staticChild, segments, index + 1, allowed);
    }

    if (rawSegment.length > 0) {
      const decoded = safeDecodeSegment(rawSegment);
      if (decoded !== undefined) {
        for (const branch of node.constrainedChildren) {
          if (branch.test(decoded)) {
            this.collectMethods(branch.node, segments, index + 1, allowed);
          }
        }
        if (node.paramChild !== undefined) {
          this.collectMethods(node.paramChild, segments, index + 1, allowed);
        }
      }
    }

    if (node.wildcardChild !== undefined) {
      const decodedTail = safeDecodeWildcard(segments.slice(index));
      if (decodedTail !== undefined) {
        for (const method of node.wildcardChild.handlers.keys()) {
          allowed.add(method);
        }
      }
    }
  }
}
