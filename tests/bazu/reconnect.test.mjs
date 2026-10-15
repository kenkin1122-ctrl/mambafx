import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupervisor, backoffDelay, LINK_DEFAULTS } from '../../src/bazu/reconnect3m.js';

function fakeEnv(over = {}) {
  let t = 0, seq = 0; const timers = new Map(), calls = { connect: 0, ping: 0, close: 0 }, states = [];
  const env = {
    calls, states, timers,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break; timers.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = end;
    },
    async flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); },
    deps: {
      connect: async () => { calls.connect++; if (env.failNext > 0) { env.failNext--; throw new Error('boom'); } },
      ping: () => { calls.ping++; }, forceClose: () => { calls.close++; sup.notifyClosed(); }, wanted: () => true,
      now: () => t, schedule: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; }, cancel: (id) => timers.delete(id),
      rand: () => 0.5, onState: (s, i) => states.push([s, i]), ...over,
    },
    failNext: 0,
  };
  const sup = createSupervisor(env.deps); env.sup = sup; return env;
}

test('backoff grows, is capped, and jitter stays within bounds', () => {
  const c = { ...LINK_DEFAULTS, JITTER: 0 };
  const d = [0, 1, 2, 3, 10, 50].map((a) => backoffDelay(a, c, () => 0.5));
  assert.ok(d[0] < d[1] && d[1] < d[2] && d[2] < d[3]);
  assert.equal(d[5], c.MAX_MS); assert.equal(d[4], c.MAX_MS);
  for (let i = 0; i < 50; i++) { const x = backoffDelay(3, LINK_DEFAULTS, Math.random), base = LINK_DEFAULTS.BASE_MS * LINK_DEFAULTS.FACTOR ** 3; assert.ok(x >= base * 0.74 && x <= base * 1.26); }
});

test('pings while connected', async () => {
  const e = fakeEnv(); await e.sup.start(); e.advance(LINK_DEFAULTS.PING_MS * 3 + 1); e.sup.touch();
  assert.ok(e.calls.ping >= 1);
});

test('close schedules a reconnect with growing delays; success resets and resyncs', async () => {
  const e = fakeEnv(); await e.sup.start(); assert.equal(e.calls.connect, 1);
  e.failNext = 2; e.sup.notifyClosed();
  const delays = () => e.states.filter(([s]) => s === 'reconnecting').map(([, i]) => i.delay);
  e.advance(60000); await e.flush(); e.advance(60000); await e.flush(); e.advance(60000); await e.flush();
  assert.equal(e.calls.connect, 4); // initial + 2 failures + success
  const d = delays(); assert.ok(d.length >= 3 && d[1] > d[0] && d[2] > d[1], JSON.stringify(d));
  assert.equal(e.sup.status.up, true); assert.equal(e.sup.status.attempt, 0); assert.equal(e.sup.status.reconnects, 1);
});

test('a silent (half-open) socket is force-closed by the watchdog, then reconnected', async () => {
  const e = fakeEnv(); await e.sup.start();
  e.advance(LINK_DEFAULTS.STALE_MS + LINK_DEFAULTS.PING_MS + 1); await e.flush();
  assert.equal(e.calls.close, 1);
  assert.ok(e.states.some(([s]) => s === 'stale'));
  assert.equal(e.calls.connect, 2); // reconnected inside the same window
});

test('messages keep a healthy socket from being closed', async () => {
  const e = fakeEnv(); await e.sup.start();
  for (let i = 0; i < 20; i++) { e.advance(10000); e.sup.touch(); }
  assert.equal(e.calls.close, 0);
});

test('kick() reconnects immediately instead of waiting', async () => {
  const e = fakeEnv(); await e.sup.start(); e.sup.notifyClosed(); assert.equal(e.calls.connect, 1);
  e.sup.kick(); await e.flush(); assert.equal(e.calls.connect, 2);
});

test('no reconnect storm: repeated close notifications schedule a single retry', async () => {
  const e = fakeEnv(); await e.sup.start(); e.sup.notifyClosed(); e.sup.notifyClosed(); e.sup.notifyClosed();
  assert.equal([...e.timers.values()].length, 1);
});

test('nothing happens when no connection is wanted', async () => {
  const e = fakeEnv({ wanted: () => false }); await e.sup.start(); e.sup.notifyClosed(); e.advance(100000); await e.flush();
  assert.equal(e.calls.connect, 0);
});
