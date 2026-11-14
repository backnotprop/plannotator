// Effect-style code: functions defined through Effect constructors and run with `yield*`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';

const kinds = async (a: string, b: string) =>
  (await semanticDiffFile('typescript', a, b)).semanticOperations.map((o) => o.type).filter((t) => t === 'extractedFunction' || t === 'inlinedFunction');

test('code moved into an Effect.gen helper run with yield* is an extract', async () => {
  const a = `export const program = Effect.gen(function* () {
  const config = yield* Config.string("API_URL");
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(\`\${config}/users\`);
  const users = yield* response.json;
  yield* Effect.log(\`loaded \${users.length} users\`);
  return users;
});
`;
  const b = `const loadUsers = Effect.gen(function* () {
  const config = yield* Config.string("API_URL");
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(\`\${config}/users\`);
  return yield* response.json;
});

export const program = Effect.gen(function* () {
  const users = yield* loadUsers;
  yield* Effect.log(\`loaded \${users.length} users\`);
  return users;
});
`;
  assert.deepEqual(await kinds(a, b), ['extractedFunction']);
});

test('code moved into an Effect.fn helper is an extract, and back again an inline', async () => {
  const a = `export class Users extends Effect.Service<Users>()("Users", {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = Effect.fn("Users.find")(function* (id: string) {
      const rows = yield* sql\`select * from users where id = \${id}\`;
      if (rows.length === 0) return yield* new UserNotFound({ id });
      yield* Effect.annotateCurrentSpan("user.id", id);
      return decodeUser(rows[0]);
    });
    return { find };
  }),
}) {}
`;
  const b = `export class Users extends Effect.Service<Users>()("Users", {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const firstRow = Effect.fn("Users.firstRow")(function* (id: string) {
      const rows = yield* sql\`select * from users where id = \${id}\`;
      if (rows.length === 0) return yield* new UserNotFound({ id });
      return rows[0];
    });
    const find = Effect.fn("Users.find")(function* (id: string) {
      const row = yield* firstRow(id);
      yield* Effect.annotateCurrentSpan("user.id", id);
      return decodeUser(row);
    });
    return { find };
  }),
}) {}
`;
  assert.deepEqual(await kinds(a, b), ['extractedFunction']);
  assert.deepEqual(await kinds(b, a), ['inlinedFunction']);
});

test('a pipe callback is not a function definition (Effect.map(fn) stays a value)', async () => {
  const a = `export const total = (items: Item[]) =>
  Effect.forEach(items, (item) => price(item)).pipe(
    Effect.map((prices) => prices.reduce((sum, p) => sum + p, 0)),
  );
`;
  const b = `const sum = (prices: number[]) => prices.reduce((sum, p) => sum + p, 0);

export const total = (items: Item[]) =>
  Effect.forEach(items, (item) => price(item)).pipe(Effect.map(sum));
`;
  // Passing \`sum\` as a value is not a call the engine can link; it must not crash or claim a rename.
  const r = await semanticDiffFile('typescript', a, b);
  assert.ok(!r.semanticOperations.some((o) => o.type === 'renamed'));
});

test('an options-object callback is not linked to an unrelated x.run() (allthingsweb `run: () => ...`)', async () => {
  const a = `export function makeHandler(pages, token) {
  const refresh = pages === undefined ? undefined : {
    token,
    run: () => refreshSite({ pages, now: Date.now }),
  };
  return (req) => refreshRequest(req, refresh?.token, () => refresh === undefined ? Promise.reject(new Error("no store")) : refresh.run());
}
`;
  const b = `export function makeHandler(pages, token) {
  const writers = pages === undefined ? undefined : {
    token,
    refresh: () => refreshSite({ pages, now: Date.now }),
  };
  return (req) => refreshRequest(req, writers?.token, () => writers === undefined ? Promise.reject(new Error("no store")) : refreshSite({ pages, now: Date.now }));
}
`;
  assert.deepEqual(await kinds(a, b), []);
});

test('an Effect helper run as `yield* helper.pipe(...)` is linked to its caller', async () => {
  const a = `export const post = Effect.fn("post")(function* (text: string) {
  const stored = yield* signIn.read;
  if (Option.isNone(stored)) return yield* refuse("No sign-in is stored.");
  const tokens = yield* refreshTokens(stored.value);
  const access = tokens.accessToken;
  yield* Effect.annotateCurrentSpan("x.posting", true);
  return yield* client.post(access, text);
});
`;
  const b = `const signedIn = Effect.gen(function* () {
  const stored = yield* signIn.read;
  if (Option.isNone(stored)) return yield* refuse("No sign-in is stored.");
  const tokens = yield* refreshTokens(stored.value);
  return tokens.accessToken;
});

export const post = Effect.fn("post")(function* (text: string) {
  const access = yield* signedIn.pipe(Effect.withSpan("x.signIn"));
  yield* Effect.annotateCurrentSpan("x.posting", true);
  return yield* client.post(access, text);
});
`;
  assert.deepEqual(await kinds(a, b), ['extractedFunction']);
});

test('a new variant added beside an unchanged function is not code moved out of the caller (effect-smol runValuesUncached)', async () => {
  const a = `export const make = (options: Options) => Effect.gen(function* () {
  const makeConnection = Effect.gen(function* () {
    const db = options.db;
    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: () => db.prepare(sql).bind(...params).raw() as Promise<ReadonlyArray<ReadonlyArray<unknown>>>,
        catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") }),
      });
    return identity<Connection>({
      executeValues(sql, params) {
        return runValues(sql, params);
      },
    });
  });
  return yield* makeConnection;
});
`;
  const b = `export const make = (options: Options) => Effect.gen(function* () {
  const makeConnection = Effect.gen(function* () {
    const db = options.db;
    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: () => db.prepare(sql).bind(...params).raw() as Promise<ReadonlyArray<ReadonlyArray<unknown>>>,
        catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") }),
      });
    const runValuesUncached = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.tryPromise({
        try: () => db.prepare(sql).bind(...params).raw() as Promise<ReadonlyArray<ReadonlyArray<unknown>>>,
        catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") }),
      });
    return identity<Connection>({
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return runValuesUncached(sql, params);
      },
    });
  });
  return yield* makeConnection;
});
`;
  assert.deepEqual(await kinds(a, b), []);
});
