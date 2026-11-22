/**
 * Tests for the EventEmitter (KER-005).
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from '../src/events.js';

describe('EventEmitter', () => {
  it('calls listeners in registration order', () => {
    const emitter = new EventEmitter();
    const calls: string[] = [];
    emitter.on('sequenceChanged', () => calls.push('first'));
    emitter.on('sequenceChanged', () => calls.push('second'));
    emitter.emit('sequenceChanged');
    expect(calls).toEqual(['first', 'second']);
  });

  it('ignores duplicate registration of the same callback (Set semantics)', () => {
    const emitter = new EventEmitter();
    let count = 0;
    const cb = () => {
      count++;
    };
    emitter.on('gcEvent', cb);
    emitter.on('gcEvent', cb);
    emitter.emit('gcEvent');
    expect(count).toBe(1);
  });

  it('removes listeners with off and tolerates unknown ones', () => {
    const emitter = new EventEmitter();
    let count = 0;
    const cb = () => {
      count++;
    };
    emitter.on('membershipChanged', cb);
    emitter.off('membershipChanged', cb);
    emitter.off('membershipChanged', cb);
    emitter.emit('membershipChanged');
    expect(count).toBe(0);
    expect(emitter.hasListeners('membershipChanged')).toBe(false);
  });

  it('keeps events independent of each other', () => {
    const emitter = new EventEmitter();
    let count = 0;
    emitter.on('gcEvent', () => {
      count++;
    });
    emitter.emit('sequenceChanged');
    expect(count).toBe(0);
  });

  it('isolates throwing listeners and reports them to onError', () => {
    const errors: Array<[string, unknown]> = [];
    const emitter = new EventEmitter((event, error) => errors.push([event, error]));
    const boom = new Error('boom');
    let reached = false;
    emitter.on('sequenceChanged', () => {
      throw boom;
    });
    emitter.on('sequenceChanged', () => {
      reached = true;
    });
    expect(() => emitter.emit('sequenceChanged')).not.toThrow();
    expect(reached).toBe(true);
    expect(errors).toEqual([['sequenceChanged', boom]]);
  });

  it('swallows listener errors when no onError handler is given', () => {
    const emitter = new EventEmitter();
    emitter.on('gcEvent', () => {
      throw new Error('ignored');
    });
    expect(() => emitter.emit('gcEvent')).not.toThrow();
  });

  it('does not let listener changes during emit affect the current emission', () => {
    const emitter = new EventEmitter();
    const calls: string[] = [];
    const late = () => calls.push('late');
    emitter.on('sequenceChanged', () => {
      calls.push('first');
      emitter.on('sequenceChanged', late);
    });
    emitter.emit('sequenceChanged');
    expect(calls).toEqual(['first']);
    emitter.emit('sequenceChanged');
    expect(calls).toEqual(['first', 'first', 'late']);
  });

  it('clear removes everything', () => {
    const emitter = new EventEmitter();
    emitter.on('gcEvent', () => undefined);
    emitter.clear();
    expect(emitter.hasListeners('gcEvent')).toBe(false);
  });
});
