import { describe, expect, it } from 'vitest';
import { createEventDispatcher } from '../src/index.js';

interface TestEvents {
  'user.created': { id: string; email: string };
  'order.paid': { orderId: string; amount: number };
}

describe('@forge-fr/core — EventDispatcher', () => {
  it('dispatches typed events sequentially in registration order and supports unsubscribe', async () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    const log: string[] = [];

    const off1 = dispatcher.on('user.created', async (payload) => {
      await Promise.resolve();
      log.push(`first:${payload.id}`);
    });
    dispatcher.on('user.created', (payload) => {
      log.push(`second:${payload.email}`);
    });

    expect(dispatcher.listenerCount('user.created')).toBe(2);
    await dispatcher.emit('user.created', { id: 'u1', email: 'a@b.com' });
    expect(log).toEqual(['first:u1', 'second:a@b.com']);

    off1();
    expect(dispatcher.listenerCount('user.created')).toBe(1);
    await dispatcher.emit('user.created', { id: 'u2', email: 'c@d.com' });
    expect(log).toEqual(['first:u1', 'second:a@b.com', 'second:c@d.com']);
  });

  it('supports once() listeners and snapshot iteration when listeners unsubscribe during emit', async () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    const calls: string[] = [];

    dispatcher.once('order.paid', (p) => {
      calls.push(`once:${p.orderId}`);
    });

    const offSecond = dispatcher.on('order.paid', (p) => {
      calls.push(`second:${p.orderId}`);
      offSecond();
    });

    dispatcher.on('order.paid', (p) => {
      calls.push(`third:${p.orderId}`);
    });

    await dispatcher.emit('order.paid', { orderId: 'o1', amount: 100 });
    await dispatcher.emit('order.paid', { orderId: 'o2', amount: 200 });

    expect(calls).toEqual(['once:o1', 'second:o1', 'third:o1', 'third:o2']);
  });

  it('enforces fail-fast, collect, and isolate error strategies', async () => {
    const failFast = createEventDispatcher<TestEvents>({ errorStrategy: 'fail-fast' });
    const ffCalls: string[] = [];
    failFast.on('user.created', () => {
      ffCalls.push('1');
      throw new Error('boom-1');
    });
    failFast.on('user.created', () => {
      ffCalls.push('2');
    });
    await expect(
      failFast.emit('user.created', { id: '1', email: 'x@y.com' }),
    ).rejects.toThrow('boom-1');
    expect(ffCalls).toEqual(['1']);

    const collect = createEventDispatcher<TestEvents>({ errorStrategy: 'collect' });
    const collectCalls: string[] = [];
    collect.on('user.created', () => {
      collectCalls.push('1');
      throw new Error('err-1');
    });
    collect.on('user.created', () => {
      collectCalls.push('2');
      throw new Error('err-2');
    });
    await expect(
      collect.emit('user.created', { id: '1', email: 'x@y.com' }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(collectCalls).toEqual(['1', '2']);

    const captured: unknown[] = [];
    const isolate = createEventDispatcher<TestEvents>({
      errorStrategy: 'isolate',
      onError: (err) => captured.push(err),
    });
    const isoCalls: string[] = [];
    isolate.on('user.created', () => {
      isoCalls.push('1');
      throw new Error('isolated-err');
    });
    isolate.on('user.created', () => {
      isoCalls.push('2');
    });
    await isolate.emit('user.created', { id: '1', email: 'x@y.com' });
    expect(isoCalls).toEqual(['1', '2']);
    expect(captured).toHaveLength(1);
  });
});
