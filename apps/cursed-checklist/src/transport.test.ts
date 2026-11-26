import { describe, it, expect } from 'vitest';
import { CHANNEL_NAME, createBroadcastTransport } from './transport';

/** Wait until `check` is true (real BroadcastChannel delivery is asynchronous). */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('createBroadcastTransport (real BroadcastChannel, as in the browser)', () => {
  it('uses the channel name bones-checklist by default', () => {
    expect(CHANNEL_NAME).toBe('bones-checklist');
  });

  it('delivers a string to the other transports on the same channel, not back to the sender', async () => {
    const name = `test-${Math.random()}`;
    const a = createBroadcastTransport(name);
    const b = createBroadcastTransport(name);
    const c = createBroadcastTransport(name);
    const got: Record<string, unknown[]> = { a: [], b: [], c: [] };
    a.onMessage((m) => got.a.push(m));
    b.onMessage((m) => got.b.push(m));
    c.onMessage((m) => got.c.push(m));
    try {
      a.send('hello');
      await waitFor(() => got.b.length === 1 && got.c.length === 1);
      expect(got.b).toEqual(['hello']);
      expect(got.c).toEqual(['hello']);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(got.a).toEqual([]);
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });

  it('onMessage returns an unsubscribe function', async () => {
    const name = `test-${Math.random()}`;
    const a = createBroadcastTransport(name);
    const b = createBroadcastTransport(name);
    const got: unknown[] = [];
    const unsubscribe = b.onMessage((m) => got.push(m));
    try {
      a.send('one');
      await waitFor(() => got.length === 1);
      unsubscribe();
      a.send('two');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(got).toEqual(['one']);
    } finally {
      a.close();
      b.close();
    }
  });

  it('channels with different names do not hear each other', async () => {
    const a = createBroadcastTransport(`test-${Math.random()}`);
    const b = createBroadcastTransport(`test-${Math.random()}`);
    const got: unknown[] = [];
    b.onMessage((m) => got.push(m));
    try {
      a.send('x');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(got).toEqual([]);
    } finally {
      a.close();
      b.close();
    }
  });
});
