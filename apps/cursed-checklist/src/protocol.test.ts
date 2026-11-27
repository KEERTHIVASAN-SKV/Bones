import { describe, it, expect } from 'vitest';
import { CRDT } from '@bones/kernel';
import type { MembershipView } from '@bones/kernel';
import {
  decode,
  encodeFrontier,
  encodeHello,
  encodeOp,
  encodePrepare,
  encodePrepared,
  encodeRejected,
  encodeRelease,
  encodeView,
} from './protocol';

const view: MembershipView = { activeMembers: new Set(['b.0', 'a.0']), evictedMembers: new Map([['c.0', 3]]), epoch: 4 };

describe('encode then decode gives the same message back', () => {
  it('op', () => {
    const op = new CRDT<{ text: string }>('a.0').insert(undefined, { text: 'hi' });
    expect(decode(encodeOp(op))).toEqual({ t: 'op', op: JSON.parse(JSON.stringify(op)) });
  });

  it('hello, with and without who it is from', () => {
    expect(decode(encodeHello('a.0', 2, new Map([['a.0', 5]])))).toEqual({
      t: 'hello', from: 'a.0', epoch: 2, vv: new Map([['a.0', 5]]),
    });
    expect(decode('{"t":"hello","vv":{"a.0":1}}')).toEqual({ t: 'hello', from: undefined, epoch: undefined, vv: new Map([['a.0', 1]]) });
  });

  it('a hello with an invalid "from" or "epoch" is still a hello (they are optional), but those fields are dropped', () => {
    expect(decode('{"t":"hello","from":"bad:id","epoch":-1,"vv":{"a.0":2}}')).toEqual({
      t: 'hello', from: undefined, epoch: undefined, vv: new Map([['a.0', 2]]),
    });
    expect(decode('{"t":"hello","from":7,"epoch":"3","vv":{}}')).toEqual({ t: 'hello', from: undefined, epoch: undefined, vv: new Map() });
  });

  it('view, frontier, prepare, prepared, release, rejected', () => {
    expect(decode(encodeView(view))).toEqual({ t: 'view', view });
    expect(decode(encodeFrontier(4, new Map([['a.0', 9]])))).toEqual({ t: 'frontier', epoch: 4, vv: new Map([['a.0', 9]]) });
    expect(decode(encodePrepare('c.0', 4))).toEqual({ t: 'prepare', target: 'c.0', epoch: 4 });
    expect(decode(encodePrepared('a.0', 'c.0', 4, 7))).toEqual({ t: 'prepared', from: 'a.0', target: 'c.0', epoch: 4, seq: 7 });
    expect(decode(encodeRelease('c.0'))).toEqual({ t: 'release', target: 'c.0' });
    expect(decode(encodeRejected('c.0', 4))).toEqual({ t: 'rejected', to: 'c.0', epoch: 4 });
  });
});

describe('decode ignores anything that is not a well-formed message, and never throws', () => {
  const BAD: unknown[] = [
    undefined, null, 5, {}, [], ['{"t":"release","target":"c.0"}'], new Uint8Array(2),
    '', 'nope', 'null', '[]', '{"t":"x"}', '{"vv":{}}',
    '{"t":"op"}', '{"t":"op","op":{}}', '{"t":"op","op":"{}"}',
    '{"t":"hello"}', '{"t":"hello","vv":[]}', '{"t":"hello","vv":{"a":1.5}}', '{"t":"hello","vv":{"a:b":1}}', '{"t":"hello","vv":null}',
    '{"t":"view"}', '{"t":"view","view":null}', '{"t":"view","view":{"activeMembers":[],"epoch":-1,"evictedMembers":{}}}',
    '{"t":"view","view":{"activeMembers":["a.0"],"epoch":1,"evictedMembers":{"a.0":1}}}',
    '{"t":"frontier","vv":{}}', '{"t":"frontier","epoch":1.5,"vv":{}}', '{"t":"frontier","epoch":1,"vv":{"a":-1}}',
    '{"t":"prepare","target":"c.0"}', '{"t":"prepare","target":"bad:id","epoch":1}', '{"t":"prepare","target":"c.0","epoch":"1"}',
    '{"t":"prepared","from":"a.0","target":"c.0","epoch":1}', '{"t":"prepared","from":"a.0","target":"c.0","epoch":1,"seq":-1}',
    '{"t":"prepared","from":"a.0","target":"c.0","epoch":1,"seq":2.5}', '{"t":"prepared","from":5,"target":"c.0","epoch":1,"seq":1}',
    '{"t":"release"}', '{"t":"release","target":""}', '{"t":"rejected","to":"a.0"}', '{"t":"rejected","to":"a.0","epoch":NaN}',
  ];
  it.each(BAD.map((m) => [m]))('%j', (message) => {
    expect(() => decode(message)).not.toThrow();
    expect(decode(message)).toBeNull();
  });
});
