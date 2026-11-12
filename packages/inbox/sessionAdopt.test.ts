import { expect, test } from 'bun:test';
import { adoptRestartedInbox, readHello, type RestartHealth, type SessionAdoptDeps } from './sessionAdopt';

const OLD = 'run-one';
const NEW = 'run-two';

function world(over: { health?: RestartHealth | Error; loaded?: string | null; cursor?: number | null; caughtUp?: string | null; session?: string | null } = {}) {
  const state = { session: 'session' in over ? over.session! : OLD, calls: [] as string[] };
  const deps: SessionAdoptDeps = {
    pageSession: () => state.session,
    loadedVersion: () => ('loaded' in over ? over.loaded! : '0.29.1'),
    pageCursor: () => ('cursor' in over ? over.cursor! : 40),
    readHealth: async () => {
      state.calls.push('health');
      if (over.health instanceof Error) throw over.health;
      return over.health ?? { serverSession: NEW, version: '0.29.1', follows: [OLD] };
    },
    catchUp: async () => {
      state.calls.push('catch-up');
      return 'caughtUp' in over ? over.caughtUp! : NEW;
    },
    adopt: (session) => {
      state.calls.push('adopt');
      state.session = session;
    },
  };
  return { state, deps };
}
const hello = { serverSession: NEW, cursor: 42 };

test('the same data, continued, on the same release: the page reads everything again, then takes the session', async () => {
  const { state, deps } = world();
  expect(await adoptRestartedInbox(hello, deps)).toEqual({ state: 'adopted' });
  expect(state.calls).toEqual(['health', 'catch-up', 'adopt']);
  expect(state.session).toBe(NEW);
});

test('a hello from the page\'s own run, or before its first list: nothing is asked', async () => {
  for (const session of [NEW, null]) {
    const { state, deps } = world({ session });
    expect(await adoptRestartedInbox(hello, deps)).toEqual({ state: 'same' });
    expect(state.calls).toEqual([]);
  }
});

test('the page slept through several restarts: a run further back in the line still counts', async () => {
  const { deps } = world({ health: { serverSession: NEW, version: '0.29.1', follows: ['run-between', OLD] } });
  expect((await adoptRestartedInbox(hello, deps)).state).toBe('adopted');
});

const refusals: [string, Parameters<typeof world>[0], typeof hello, string][] = [
  ['another data folder (no line, a copy or a restore)', { health: { serverSession: NEW, version: '0.29.1' } }, hello, 'not-followed'],
  ['a line that does not name the page\'s run', { health: { serverSession: NEW, version: '0.29.1', follows: ['someone-else'] } }, hello, 'not-followed'],
  ['a newer release', { health: { serverSession: NEW, version: '0.29.2', follows: [OLD] } }, hello, 'other-version'],
  ['an older release', { health: { serverSession: NEW, version: '0.29.0', follows: [OLD] } }, hello, 'other-version'],
  ['a store behind what the page read (reset or restored)', {}, { serverSession: NEW, cursor: 39 }, 'cursor-behind'],
  ['a health answer from yet another run', { health: { serverSession: 'run-three', version: '0.29.1', follows: [OLD] } }, hello, 'other-run'],
  ['no health answer', { health: new Error('timeout') }, hello, 'no-health'],
  ['a page that never read a list', { cursor: null }, hello, 'not-loaded'],
  ['a failed read of the list', { caughtUp: null }, hello, 'not-read'],
  ['a list read from another run', { caughtUp: 'run-three' }, hello, 'not-read'],
];
for (const [name, over, frame, why] of refusals) {
  test(`refused, the page keeps its session: ${name}`, async () => {
    const { state, deps } = world(over);
    expect(await adoptRestartedInbox(frame, deps)).toEqual({ state: 'refused', why } as never);
    expect(state.session).toBe(OLD);
    expect(state.calls).not.toContain('adopt');
  });
}

test('a store behind the page, or another release, is refused before anything is read again', async () => {
  const behind = world();
  await adoptRestartedInbox({ serverSession: NEW, cursor: 1 }, behind.deps);
  expect(behind.state.calls).toEqual([]);
  const release = world({ health: { serverSession: NEW, version: '9.9.9', follows: [OLD] } });
  await adoptRestartedInbox(hello, release.deps);
  expect(release.state.calls).toEqual(['health']);
});

test('the session moved while the page read (another restart, a Reload): left to the next hello', async () => {
  const { state, deps } = world();
  const result = await adoptRestartedInbox(hello, {
    ...deps,
    catchUp: async () => {
      state.session = 'run-three';
      return NEW;
    },
  });
  expect(result).toEqual({ state: 'refused', why: 'moved-on' });
  expect(state.session).toBe('run-three');
});

test('a hello is read only when it names a run and a cursor', () => {
  expect(readHello('{"serverSession":"abc","cursor":7}')).toEqual({ serverSession: 'abc', cursor: 7 });
  expect(readHello('{"serverSession":"","cursor":7}')).toBeNull();
  expect(readHello('{"serverSession":"abc"}')).toBeNull();
  expect(readHello('not json')).toBeNull();
});
