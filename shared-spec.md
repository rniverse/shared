# shared (`@rniverse/shared`) — Specification

This document reflects decisions made during design discussion, not a
read-back of the implementation. Where the implementation is known to
diverge from a decision below, it's called out explicitly in
**Discrepancies found**, at the end, rather than silently matched.

## 1. Purpose

A staging package for code duplicated across `aham`/`notify` (or any future
service in this workspace) that hasn't earned a place in
`@rniverse/utils`/`@rniverse/connectors` yet. It is not a grab-bag — code
moves here only once it's found byte-identical (or near enough) across two
or more repos, and is expected to promote out to `utils`/`connectors` if it
ever becomes generic enough to lose its "these specific services" framing.
It owns no business logic and reads no environment variables of its own —
every value it needs is passed in by the caller's own `config` module.

## 2. Tech stack

- **Runtime:** Bun for local dev; `Bun.serve` is used directly in
  `lib/bootstrap.ts`'s `listen()`, so unlike `aham`/`notify` this package
  is not held to the Bun-optional standard — it *is* the piece that owns
  the Bun-specific server call, on behalf of both consumers.
- **Framework integration:** Elysia — `createApp()` builds the shared app
  shell (error envelope, openapi docs, request-context wrap) around a
  caller-supplied Elysia instance; `elysia` and `@elysiajs/openapi` are
  `peerDependencies`, not bundled.
- **Validation docs:** `@valibot/to-json-schema`, used only to render
  openapi schemas from the caller's valibot route schemas (`errorMode:
  'ignore'` — transforms have no JSON Schema equivalent, skipped silently
  rather than warning per request).
- **Kafka: none — revised.** The registry used to create and subscribe
  Kafka producers / consumers. Since the connectors rewrite, that lifecycle
  lives in `@rniverse/connectors`: producers / consumers are declared in the
  `KafkaConnector`'s config and connected with it; the owning service only
  subscribes / runs (in the consumer's `connect` listener). `kafkajs`
  is no longer a dependency of this package.
- **Shared libs:** `@rniverse/utils` for `log`, `sync$seq`, `runWithContext`,
  `cxt$req`, its `request` re-export (`http()`/`HttpClient`/`ClientConfig`/
  `trace$`), its `result` re-export (`Result`). `@rniverse/connectors` is a
  **devDependency only** (the registry tests use a real `PostgresConnector`);
  `lib/` never imports it — the registry takes any `{connect, close,
  health}` shape.
- **Lint/format:** Biome, mirrors `aham`/`notify`'s config.
- **Peer vs. regular dependencies — load-bearing, not a style choice:**
  `@rniverse/utils`, `@elysiajs/openapi`, `@valibot/to-json-schema`,
  `elysia`, and `typescript` are all `peerDependencies`; `dependencies` is empty (`{}`). This is what lets
  `shared`'s code resolve those imports against the *consumer's own*
  installed copy instead of a separate one nested inside
  `@rniverse/shared`, so `err instanceof HttpError` (and any other
  cross-package `instanceof` check — `AppError` included) actually works.
  Confirmed empirically: under a local `file:../shared` link, `shared`
  carried its own `node_modules/@rniverse/utils` (from `bun install` run
  inside `shared/` for local dev), so `instanceof` silently failed — two
  different class identities for "the same" package. The git-published
  `dist` branch has no `node_modules`, so bun hoists cleanly against the
  consumer's own install. If a future dependency of `shared` ever needs a
  class-based check on the consumer side, it must stay a peerDependency,
  never a regular one. See the workspace root's
  `/Users/sage/git/rniverse/CLAUDE.md` (`## shared` section) for the same
  rule stated as a standing workspace rule.

## 3. Core architecture decision: pure factories, zero module-level state

Every export (`createRegistry`, `createApp`, `createErrorEnum`) is a
factory function that returns fresh, independent state on each call —
nothing in this package is a singleton or holds state at module scope.
This was checked deliberately (not assumed) when the question came up of
whether the design would still work with multiple Postgres DBs in one
service: it does, with zero changes to this package, because a caller can
list two connectors in one `createRegistry({connections})` call, or call
`createRegistry()` twice and compose the results — there is no shared
registry instance for a second call to collide with. (Multiple Kafka
clusters are now just multiple `KafkaConnector`s in the owning service, §6.) The same holds
for `createErrorEnum` (two independent error lists, two independent
`AppError` classes) and for `createApp` (nothing here prevents building two
separate Elysia app instances, though no current service does).

## 4. Package layout & exports

```
index.ts                      — barrel: re-exports everything below
lib/registry.ts                — createRegistry (connections/http)
lib/bootstrap.ts                — createApp, listen, registerShutdown, boot
lib/error.ts                    — createErrorEnum, reasonOf
middlewares/log.middleware.ts   — request-logging Elysia plugin
tests/                          — this package's own test suite (§12)
docker-compose.yml              — local Postgres for tests/ (§12)
```

Published as **subpath exports**, not only the barrel — every consumer
import in `aham`/`notify` uses the specific subpath
(`@rniverse/shared/registry`, `@rniverse/shared/bootstrap`,
`@rniverse/shared/error`), never the bare `@rniverse/shared` barrel or
`@rniverse/shared/log.middleware` directly (the logger is wired internally
by `createApp()`, no consumer needs it standalone today, though the
subpath is exported in case one ever does):

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./error": { "types": "./dist/lib/error.d.ts", "default": "./dist/lib/error.js" },
  "./registry": { "types": "./dist/lib/registry.d.ts", "default": "./dist/lib/registry.js" },
  "./bootstrap": { "types": "./dist/lib/bootstrap.d.ts", "default": "./dist/lib/bootstrap.js" },
  "./log.middleware": { "types": "./dist/middlewares/log.middleware.d.ts", "default": "./dist/middlewares/log.middleware.js" },
  "./package.json": "./package.json"
}
```

**Two branches, one repo** — `main` (source, `dist/` gitignored) and `dist`
(built output committed, `dist/` tracked, no gitignore entry for it).
Consumers depend on it as
`"@rniverse/shared": "github:rniverse/shared#dist"` — never `file:../shared`
for anything durable; that was a local-dev-only stopgap before the repo
existed, and is exactly the setup that broke `instanceof` (§2).

**Publish workflow**, mirrors `utils`/`connectors`:
1. Commit and push `main`.
2. `git checkout dist && git merge main`.
3. `rm -rf node_modules dist && bun install && bun run build`
   (`tsc --project tsconfig.build.json && tsc-alias --project
   tsconfig.build.json` — emits `.js`+`.d.ts`+sourcemaps to `dist/`,
   `tsc-alias` resolves the `@lib/*`/`@middlewares/*` path aliases to
   relative imports since the published package ships no path-alias
   resolution of its own).
4. Commit ("build"), push `dist`.
5. `git checkout main` (back to source branch for the next round of edits).
6. In each consumer: `bun update @rniverse/shared` — bumps the commit pin
   in `bun.lock` to the new `dist` HEAD. Nothing else in the consumer
   needs to change unless the new commit also changed a type shape it
   uses.

As of this writing both `aham` and `notify` are pinned to the same `dist`
commit (`cb5a503`) — confirmed via `bun.lock`, not assumed.

## 5. `lib/registry.ts` — connection/HTTP lifecycle

**Confirmed.** Generalizes two things every consumer was hand-rolling
identically, differing only in *which* connectors/services: the
connection-lifecycle state machine (status + health aggregator +
init/close) and a named HTTP-client map. (It used to do Kafka
producer/consumer setup too — **removed**, see §2 and §6.)

### Connections

```ts
type ConnectionConfiguration = { name: string; connector: Connector; required: boolean };
```
`connector` is any object shaped `{connect(), close(), health()}` — every
`@rniverse/connectors` connector (`PostgresConnector`, `KafkaConnector`, …)
fits. A connectors link's `health()` and `close()` never throw (failures come
back as a `Result`), and its `health()` is time-limited, so one hung
dependency can't stall the aggregate report.
`required` drives both connect and health-check behavior: a required
connector is awaited at `init()` and failing at `connect()` is fatal
(`process.exit(1)`); an optional one **connects in the background** — not
awaited, so a slow or unreachable dependency never holds up boot; a failure
is logged as a warning and only its own health entry reports unhealthy. `health()` aggregates every configured
connector into `{ok, isInWorkingState, services}` — `isInWorkingState` is
false only if a *required* connector is unhealthy; an unhealthy optional
one still allows `ok: false` but leaves working state true.

### HTTP

```ts
type HttpConfiguration = ClientConfig & { name: string };
```
`createHttp()` returns a plain `Map<string, HttpClient>` built from
`@rniverse/utils/request`'s `http()`. Callers look a client up by name:
`http().get('notify')` (aham's pattern for its one named client to the
`notify` service).

### `createRegistry()` — the composition point

```ts
function createRegistry(config: {
  connections?: ConnectionConfiguration[];
  http?: HttpConfiguration[];
}): {
  connections: () => { init, close, health, status };
  http: () => Map<string, HttpClient>;
}
```
Every accessor is a **getter function, not a plain property** — matches
the `pg()`/`mail()` convention every consumer already uses for shared
instances (`connections()`, `http()`, not `.connections`, `.http`).
`connections().init()` is the one call that brings everything up: sets
state to `INITIALIZING`, awaits the required connections, starts the
optional ones in the background, sets state to `READY`. It returns nothing
and runs **no** health check (**revised** — it used to run one and return the
report: for just-awaited connections that added nothing, and for background
ones it was premature, logging "unhealthy" at every boot). Health runs only
when asked — `connections().health()`, e.g. from `/api/health`.

## 6. Kafka producers / consumers — owned by the service

**Revised.** The registry no longer touches Kafka. A service declares its
producers / consumers in its `KafkaConnector`'s config (the connector connects
them, and kafkajs restarts a crashed consumer by itself) and only attaches
what needs its own message handler: `subscribe()` + `run()` in the
consumer's `connect` listener, which fires once per new consumer object. The `consumers/` directory
convention (one `onEachMessage` per `consumers/<name>.consumer.ts`, a
`subscribers` map typed against the consumer config so a missing handler is a
`tsc` error) stays in each service's own `src/`; see `notify`.

## 7. `lib/bootstrap.ts` — Elysia app shell & process lifecycle

**Confirmed.** Generalizes the Elysia app shell every service was
hand-rolling identically: error envelope, openapi docs, and the
per-request `AsyncLocalStorage` wrap. Deliberately split into pieces
rather than one `init()` — a caller that needs an extra step before
listening just sequences it
between calls, no special hook needed here.

### `createApp(options)`

```ts
type CreateAppOptions = {
  api: any; // the caller's own Elysia instance — used structurally only
  errors: { AppError: new (...) => {...}; NOT_FOUND: ErrorSpec; VALIDATION_FAILED: ErrorSpec; INTERNAL_ERROR: ErrorSpec };
};
```
`errors` bundles `AppError` *alongside* the three specs it needs, as one
object — not a separate parameter — because both come from the same
`createErrorEnum()` call and are always passed together (see each
consumer's `BOOTSTRAP_ERRORS` constant, §9). Builds the app with:
- `.error({ AppError })` + a global `onError` that returns the
  `{ok: false, error: {code, message}}` envelope for `AppError` instances,
  Elysia's own `VALIDATION`/`NOT_FOUND` internal errors (mapped to the
  caller's specs), and anything else (mapped to `INTERNAL_ERROR`) — no
  path leaks Elysia's raw internal error shape.
- `.use(openapi({...}))` — valibot-to-JSON-Schema wiring, `errorMode:
  'ignore'` (§2).
- `.use(api)` — the caller's routes, mounted last.
- Rewraps `app.handle` via `cxt$req.bindFetch` so every request — whether
  arriving through `Bun.serve` or a direct `app.handle()` call in tests —
  runs inside its own `AsyncLocalStorage` store.

`api: any` is deliberate, not a shortcut: each repo's `createAPI()`
returns an Elysia instance typed with its own route/schema generics;
forcing that through a concretely-typed parameter here trips Elysia's
invariant plugin-composition types at the function boundary. The app is
used structurally only (`.error`/`.onError`/`.use`), never for
route-level type inference.

### `listen(app, config)`

Thin `Bun.serve()` wrapper — `{port, host}` in, a logged "Elysia is
running at ..." line, returns the server.

### `registerShutdown({onShutdown})`

Wires `SIGINT`/`SIGTERM`/`uncaughtException`/`unhandledRejection` to one
`shutdown(signal)` body, guarded by an `isShuttingDown` flag so the body
runs at most once per process even if a signal is double-forwarded (e.g.
a shell wrapping `bun run` re-raising it) or fires from two listeners at
once. `process.listenerCount('SIGINT') === 0` gate is separate, cheaper
insurance against this whole block running twice in one process — not the
actual duplicate-shutdown fix, which is the flag.

### `boot(init, serverConfig, onShutdown)`

```ts
export function boot<App extends {handle: unknown}>(
  init: () => Promise<App>,
  serverConfig: {port: number; host: string},
  onShutdown: (signal: string) => Promise<void>,
): void {
  const {unknownErrorListener} = registerShutdown({onShutdown});
  runWithContext(async () => init().then((app) => listen(app, serverConfig)), {requestId: 'SERVER_LOG'})
    .catch(unknownErrorListener);
}
```
Folds the `if (import.meta.main) { ... }` body that was byte-identical
between `aham` and `notify` — wire shutdown, then run
`init().then(listen)` inside its own request context so early startup
logs carry a `requestId`. The `import.meta.main` guard itself stays in
each caller's own `index.ts`: `import.meta` is per-module, checking it
inside `shared` would only ever reflect `shared`'s own module, never the
calling repo's.

## 8. `lib/error.ts` — error-enum factory

**Confirmed.** Generalizes the `[key, message, status]` list + `AppError`
pattern every service was hand-rolling identically — only the list
content ever differed. Each repo keeps its own list local (`aham`'s in
`enums/errors.enum.ts`, `notify`'s likewise); this package owns only the
mechanism.

```ts
type ErrorEntry = readonly [key: string, message: string, status: number];
function createErrorEnum<const L extends readonly ErrorEntry[]>(list: L): {
  key: Record<ErrorKey, ErrorKey>;
  messages: Record<ErrorKey, string>;
  codes: Record<ErrorKey, string>;
  status: Record<ErrorKey, number>;
  spec: (key: ErrorKey) => { code, message, status };
  AppError: class extends Error { key, code, status_code, details };
};
```
Codes are sequential, generated via `@rniverse/utils`'s `sync$seq`
(`{type: 'code', length: 10, radix: 10}`) — one fixed-length numeric code
per list entry, in declaration order, never reused across a process's
lifetime. `spec(key)` returns the `{code, message, status}` triple
`createApp()`'s `onError` needs for exactly the three bootstrap-level keys
(`NOT_FOUND`/`VALIDATION_FAILED`/`INTERNAL_ERROR`); a consumer's own
richer error list stays entirely its own, `createErrorEnum` doesn't know
or care what's in it beyond the `[key, message, status]` shape.

`AppError`'s `status_code` falls back through `details?.status_code` →
the list's declared `status[key]` → `400`, in that order — lets a caller
override the status per-throw-site via `details` without needing a second
list entry for the same logical error at a different status.

`reasonOf(error)` — `error instanceof Error ? error.message : String(error)`
— a one-line normalizer used where a caught value's shape isn't guaranteed
to be an `Error` (e.g. `notify`'s Kafka consumer catch blocks).

## 9. `middlewares/log.middleware.ts` — request logging

**Confirmed.** `logger()` is an Elysia plugin logging one line on request
start and one on response complete (method, path, status, elapsed ms —
`error` level at 400+, `info` otherwise). **Path only, no querystring** —
deliberate: a route carrying secrets in query params (an OAuth callback's
`code`/`state`, in `aham`'s case) must never land in logs. Wired internally
by `createApp()` (`.use(logger())`); no consumer imports this subpath
directly today, though it's still exported standalone in case a future
caller needs the plugin outside the full `createApp()` shell.

## 10. Consumers — what each repo actually uses

| | `aham` | `notify` |
|---|---|---|
| `registry` — connections | postgres (required) | postgres (required); Kafka links owned by notify (§6) |
| `registry` — http | `notify` (named client) | — |
| `bootstrap` | `createApp`/`listen`/`boot` | `createApp`/`listen`/`boot` |
| `error` | `createErrorEnum`; `reasonOf` not used | `createErrorEnum`; `reasonOf` (Kafka catch blocks) |
| `log.middleware` | via `createApp()` only | via `createApp()` only |

Neither consumer imports the bare `@rniverse/shared` barrel — every import
is a specific subpath (§4). Both are pinned to the same `dist` commit as
of this writing (§4) — confirmed via `bun.lock`, not assumed, after an
earlier drift (`aham` briefly a few commits behind `notify`) was caught by
a systematic `bun.lock` comparison and fixed with `bun update
@rniverse/shared`.

## 11. Deliberately deferred (not built, not in scope for this version)

- Promoting any piece of this package into `@rniverse/utils`/
  `@rniverse/connectors` proper — stays here until a third consumer (or a
  clearly-generic enough shape) makes the case.
- A `services()`-style named-service registry generalizing `http()` beyond
  plain HTTP clients — not needed while every non-DB, non-Kafka dependency
  a consumer has is exactly one HTTP call away.
- Multiple simultaneous Postgres DBs in one consumer —
  confirmed compatible with the current design via composing multiple
  `createRegistry()` calls (§3), but no consumer needs it yet, so nothing
  further was built toward it.
- A `services()`/`ms()`-named alias for `http()` — considered during
  naming discussion, `http()` was kept since every current use is a plain
  named HTTP client, not a heavier "microservice" abstraction.

## 12. Tests

**Resolved** — this package now has its own direct test suite under
`tests/`, one directory per multi-file module (mirroring `lib/`), one flat
file per single-file module:

```
tests/error.test.ts               — createErrorEnum, reasonOf (pure unit)
tests/log.middleware.test.ts      — logger() Elysia plugin
tests/bootstrap/create-app.test.ts     — error envelope, context wrap, openapi
tests/bootstrap/listen.test.ts         — Bun.serve wiring (spied)
tests/bootstrap/register-shutdown.test.ts — signal/exit paths (spied + a real subprocess)
tests/bootstrap/boot.test.ts           — the composed import.meta.main body
tests/registry/connections.test.ts     — connection lifecycle/health/close
tests/registry/http.test.ts            — named HTTP client map
```

43 tests, 104 assertions, 100% line coverage on `registry.ts`/`error.ts`,
99%+ overall (`bun test --coverage`). The one documented gap:
`log.middleware.ts`'s `pathOf()` catch branch (an unparsable
`request.url`) is unreachable through a real `Request` — Bun/undici always
hand it a valid absolute URL — so it's left uncovered rather than faked
with a call this code can never actually receive in production.

**No mocking of this package's own units.** Every test either exercises
real code through its real entrypoint (`app.handle()` for `createApp`,
a real Postgres via Docker for `connections`) or substitutes only the *external* boundary the design
itself is built around — a hand-written `Connector`-shaped stub for
connect/health branch testing (exactly the interface `registry.ts` takes
as config, not an internal of it), `process.exit`/`Bun.serve` spies
(can't let a test actually kill the runner or bind a real port), and one
throwaway `bun -e` child process to prove `SIGINT` really is wired to a
clean `process.exit(0)` without polluting the shared test process's
global signal-listener state.

**Local test infrastructure — Docker Compose, not live cloud creds.**
`docker-compose.yml` at the repo root brings up `postgres:18-trixie`
(host port `55432` — `5432` was already taken by an unrelated container
on the dev machine). (A Kafka service was there too until the registry's
Kafka code moved to `@rniverse/connectors`, which tests Kafka itself.) This
replaced an earlier `.env.test` that pointed at a
live Aiven-hosted broker with real SASL credentials — dropped entirely
once Compose proved sufficient, both to remove the live secret from a
gitignored-but-still-real-credential file and to make `bun run test` not
depend on any external service being up. `bun run docker:up` (`docker
compose up -d --wait`) / `bun run docker:down` (`docker compose down -v`)
wrap it; `.env.test` (git-ignored) points at the Compose services.
`bun run test:coverage` runs the same suite under `bun test --coverage`.

## 13. Open decisions

1. **Promotion criteria to `utils`/`connectors`** (§11) — "a third
   consumer" was floated informally as the trigger, never written down as
   a hard rule.

**Built and verified** — typechecks clean in both `aham` and `notify`
against the published `dist` branch; this package's own 47-test suite
(§12) green against real Dockerized Postgres/Kafka; `createRegistry`'s
Kafka path additionally smoke-tested as a real running process against
the actual Aiven-hosted broker (publish → subscribe → group-join →
consume → dispatch → real email sent, via `notify`); the peerDependencies
fix for cross-package `instanceof` verified empirically both broken
(under a local `file:` link) and fixed (after publishing for real), via a
live test script showing `instanceof HttpError: true`; the `consumers/`
directory's compile-time subscriber/config correspondence verified by
deliberately breaking it and confirming a real `tsc` error, then
reverting.

---

## Discrepancies found while writing this document

None — this document was written directly from current source
(`lib/registry.ts`, `lib/bootstrap.ts`, `lib/error.ts`,
`middlewares/log.middleware.ts`, `package.json`, both consumers'
`bun.lock` and call sites), not backfilled from an earlier design doc, so
there was no prior text to diverge from.
