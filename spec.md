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
- **Kafka:** `kafkajs` types only (`Consumer`, `Producer`,
  `ConsumerConfig`, `ProducerConfig`, `ConsumerGroupJoinEvent`) — the
  actual client construction is `@rniverse/connectors`' `RedpandaConnector`
  job; `lib/registry.ts` only shapes config and holds the resulting
  instances in a `Map`.
- **Shared libs:** `@rniverse/utils` for `log`, `sync$seq`, `runWithContext`,
  `cxt$req`, its `request` re-export (`http()`/`HttpClient`/`ClientConfig`/
  `trace$`), its `result` re-export (`Result`). `@rniverse/connectors` for
  `RedpandaConnector`'s type (registry only handles the type; the instance
  itself is constructed by and passed in from the caller).
- **Lint/format:** Biome, mirrors `aham`/`notify`'s config.
- **Peer vs. regular dependencies — load-bearing, not a style choice:**
  `@rniverse/utils`, `@rniverse/connectors`, `@elysiajs/openapi`,
  `@valibot/to-json-schema`, `elysia`, `kafkajs`, and `typescript` are all
  `peerDependencies`; `dependencies` is empty (`{}`). This is what lets
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
whether the design would still work with multiple Postgres DBs or multiple
Kafka clusters in one service: it does, with zero changes to this package,
because a caller that needs two independent Kafka clusters just calls
`createRegistry({kafka: {...}})` twice and composes the two results itself
(two `connect()` calls, two `producers`/`consumers` maps) — there is no
shared registry instance for a second call to collide with. The same holds
for `createErrorEnum` (two independent error lists, two independent
`AppError` classes) and for `createApp` (nothing here prevents building two
separate Elysia app instances, though no current service does).

## 4. Package layout & exports

```
index.ts                      — barrel: re-exports everything below
lib/registry.ts                — createRegistry (connections/http/kafka)
lib/bootstrap.ts                — createApp, listen, registerShutdown, boot
lib/error.ts                    — createErrorEnum, reasonOf
middlewares/log.middleware.ts   — request-logging Elysia plugin
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

## 5. `lib/registry.ts` — connection/HTTP/Kafka lifecycle

**Confirmed.** Generalizes three things every consumer was hand-rolling
identically, differing only in *which* connectors/services/topics:
connection-lifecycle state machine (status + health aggregator +
init/close), a named HTTP-client map, and Kafka producer/consumer setup.

### Connections

```ts
type ConnectionConfiguration = { name: string; connector: Connector; required: boolean };
```
`connector` is any object shaped `{connect(), close(), health()}` —
`SQLConnector`, `RedpandaConnector`, anything future that fits the shape.
`required` drives both connect and health-check behavior: a required
connector failing at `connect()` is fatal (`process.exit(1)`); an optional
one is best-effort — logged, doesn't take `init()` down, only its own
health entry reports unhealthy. `health()` aggregates every configured
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

### Kafka

```ts
type KafkaProducerConfiguration = Partial<ProducerConfig> & { name: string };
type KafkaConsumerConfiguration = (ConsumerConfig & { topic: string; fromBeginning?: boolean }) & { name: string };
```
Declarative: `producers`/`consumers` are `Record<string, ...Configuration>`
objects; `createKafka().connect()` connects every producer and
subscribes every consumer (subscribing only — actually consuming needs
`.run({eachMessage})`, left to the caller, see §6).

**Name-decoupling (confirmed, deliberate):** each entry's `name` field is
the *actual* registry/log key — what `producers.get()`/`consumers.get()`
look up, and what appears in log lines. The object's own property key
(e.g. `config.kafka.producers.notifier`) is a separate, stable,
typo-checked TS reference, independent of the runtime `name`. This lets a
consumer rename the runtime label (env-driven — `KAFKA_NOTIFIER_NAME`,
defaults to `'notifier'`) per deployment without touching any call site
that references `config.kafka.producers.notifier`. A producer failing to
connect at startup is logged and stored as `null` in the map (not thrown)
— matches the "optional connection" best-effort philosophy above, since a
Kafka outage at boot shouldn't take a service down if it can still serve
HTTP.

A subscribed consumer additionally gets a `GROUP_JOIN` listener logged —
`subscribe()` resolving doesn't mean the group finished joining, that
handshake runs against the broker in the background and can take a few
seconds; this makes "hadn't joined yet" visible instead of a silent gap.

### `createRegistry()` — the composition point

```ts
function createRegistry(config: {
  connections?: ConnectionConfiguration[];
  http?: HttpConfiguration[];
  kafka?: { connector: RedpandaConnector; producers?: Record<...>; consumers?: Record<...> };
}): {
  connections: () => { init, close, health, status };
  http: () => Map<string, HttpClient>;
  kafka: () => { connect, producers: Map, consumers: Map } | undefined;
}
```
Every accessor is a **getter function, not a plain property** — matches
the `pg()`/`mail()` convention every consumer already uses for shared
instances (`connections()`, `http()`, `kafka()`, not `.connections`,
`.http`, `.kafka`). `kafka()` returns `undefined` when the caller passed
no `kafka` config at all (aham's case — it never touches Kafka).
`connections().init()` is the one call that brings everything up: sets
state to `INITIALIZING`, connects required/optional connections, connects
Kafka if configured, runs the health check, sets state to `READY`, and
returns the health report.

**Pass the *same* connector instance to both `connections` and `kafka`.**
`kafka.connector` needs the concrete `RedpandaConnector`
(`getProducer`/`getConsumer`); `connections` tracks it under the generic
`Connector` shape (`connect`/`close`/`health`) for lifecycle/health
purposes. A caller lists it once in each place, pointing at one instance —
this is not two separate connections to the broker.

## 6. `consumers/` directory convention (per-repo, not shared code)

**Confirmed**, lives in each consumer's own `src/`, not in this package —
documented here because the registry's design assumes it. `createKafka()`
only subscribes; dispatching an incoming message needs the caller's own
domain logic (DB tables, services), which `shared` has no business owning.
The convention each repo follows:

- `consumers/<name>.consumer.ts` exports one `onEachMessage` handler.
- `consumers/index.ts` exports `{ subscribers, start }`:
  ```ts
  const subscribers: Record<keyof typeof config.kafka.consumers, EachMessageHandler> = { <name>: onEachMessage, ... };
  async function start() {
    for (const [key, entry] of Object.entries(config.kafka.consumers)) {
      await kafka()?.consumers.get(entry.name)?.run({ eachMessage: subscribers[key] });
    }
  }
  ```
  The `Record<keyof typeof config.kafka.consumers, ...>` type is what
  makes this compile-time-enforced: every declared consumer *must* have a
  matching handler, or `tsc` fails with a missing-property error. Verified
  directly — deliberately breaking the correspondence (emptying
  `subscribers`) produced a real `tsc` error before being reverted, not
  just claimed.
- This lives in its own directory (not folded into `services/`) so
  `consumers/*.consumer.ts` can import from `services/` without a
  circular-import risk the other way around.

## 7. `lib/bootstrap.ts` — Elysia app shell & process lifecycle

**Confirmed.** Generalizes the Elysia app shell every service was
hand-rolling identically: error envelope, openapi docs, and the
per-request `AsyncLocalStorage` wrap. Deliberately split into pieces
rather than one `init()` — a caller that needs an extra step before
listening (e.g. notify's Kafka consumer `start()`) just sequences it
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
| `registry` — connections | postgres (required) | postgres (required), redpanda (optional) |
| `registry` — http | `notify` (named client) | — |
| `registry` — kafka | not used | producers: `notifier`; consumers: `notifications` |
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
- Multiple simultaneous Kafka clusters or Postgres DBs in one consumer —
  confirmed compatible with the current design via composing multiple
  `createRegistry()` calls (§3), but no consumer needs it yet, so nothing
  further was built toward it.
- A `services()`/`ms()`-named alias for `http()` — considered during
  naming discussion, `http()` was kept since every current use is a plain
  named HTTP client, not a heavier "microservice" abstraction.

## 12. Tests

**Known gap:** there are no test files in this repo (`find . -name
'*.test.ts'` under `lib`/`middlewares` returns nothing). The `test` script
(`bun test`) exists in `package.json` but currently has nothing to run —
correctness has been established only via the consumers' own test suites
(`aham`'s 112 tests, `notify`'s integration tests) exercising this
package's code indirectly through `createRegistry`/`createApp`/
`createErrorEnum`, plus repeated live smoke tests against the real
Aiven-hosted Kafka broker and Resend (documented in `notify/spec.md` §18).
Nothing in this package has a test that exercises it in isolation.

## 13. Open decisions

1. **Direct unit tests for this package** (§12) — not blocking today since
   both consumers' own suites exercise it, but a bug introduced here would
   currently only surface through `aham`'s or `notify`'s tests, not this
   package's own.
2. **Promotion criteria to `utils`/`connectors`** (§11) — "a third
   consumer" was floated informally as the trigger, never written down as
   a hard rule.

**Built and verified** — typechecks clean in both `aham` and `notify`
against the published `dist` branch; `createRegistry`'s Kafka path
repeatedly smoke-tested as a real running process against the actual
Aiven-hosted broker (publish → subscribe → group-join → consume →
dispatch → real email sent, via `notify`); the peerDependencies fix for
cross-package `instanceof` verified empirically both broken (under a local
`file:` link) and fixed (after publishing for real), via a live test
script showing `instanceof HttpError: true`; the `consumers/` directory's
compile-time subscriber/config correspondence verified by deliberately
breaking it and confirming a real `tsc` error, then reverting.

---

## Discrepancies found while writing this document

None — this document was written directly from current source
(`lib/registry.ts`, `lib/bootstrap.ts`, `lib/error.ts`,
`middlewares/log.middleware.ts`, `package.json`, both consumers'
`bun.lock` and call sites), not backfilled from an earlier design doc, so
there was no prior text to diverge from.
