# 06 — Property and state-machine test plan

Status: blocking implementation plan. Tests are executable evidence, not design
examples. Every generated failure reports seed and minimized trace. No source
implementation starts before all six design documents are committed and pushed.

## 1. Test architecture and gates

Four layers share one vocabulary of commands, observations, terminal results,
and resource ownership:

1. pure Elm reference machine and generators;
2. canonical JavaScript transaction with deterministic injected operations;
3. real pinned Node 24 local-server tests through compiled Elm apps;
4. frozen-legacy versus integrated harness differential tests.

Every layer runs in both compiler debug and `--optimize` where applicable. A
supervisor gives every shard, worker, server, and child process a hard deadline,
kills its process group on timeout, closes servers in `finally`, and reports the
seed. No test may rely on the public internet, ambient `~/.elm`, npm cache, DNS,
or an unbounded sleep.

A manifest records nonzero expected property counts. Runners fail when a worker
only compiles, exits before reporting, reports zero cases, uses stale generated
JS, or omits either build mode.

## 2. Pure reference state machine

The pure Elm model contains:

```elm
type Phase
    = Prepared
    | BeforeResponse Resources
    | ResponseNoBody Resources
    | BeforeReader Resources
    | ReaderIdle Resources Counters
    | ReadPending Resources Counters ReadToken
    | ReaderEnded
    | CallbackQueued Terminal
    | Abandoned
    | Absent

type Terminal
    = Succeeded ResponseModel
    | Failed ErrorKind Site (Maybe AllowedCode)

type Command
    = Start DispatchFacts
    | PhysicalFetchResolved ResponseFacts
    | PhysicalFetchRejected ExceptionFact
    | AcquireReader
    | PhysicalRead ReadToken Bytes
    | PhysicalEof ReadToken
    | PhysicalReadRejected ReadToken ExceptionFact
    | TimerFired TimerToken
    | DeliveryAcknowledged
    | Kill
    | CleanupPromiseRejected CleanupKind
    | Stale Command
```

“Physical” transport settlement, logical terminal claim, callback queueing,
delivery acknowledgment, and kill are distinct observations. Delivery
acknowledgment does not control cleanup; it only proves the scheduler callback
was observed by the fixture app.

### Generated properties

For generated valid initial requests and interleavings:

1. at most one `Succeeded`/`Failed` callback is queued;
2. no callback is queued if Kill claims `Abandoned` first;
3. kill after `CallbackQueued` cannot retract or duplicate delivery;
4. timer first always yields `DeadlineExceeded`, even if abort synchronously
   throws or later rejects Fetch;
5. cap first always yields typed truncation/failure, never a racing network kind;
6. stale timer/read/fetch tokens cannot mutate current or absent state;
7. every terminal/abandoned state owns zero timer, controller, reader, body,
   pending read token, and retained chunk references;
8. cleanup repeats and cleanup promise rejection never alter terminal result;
9. callback state is `CallbackQueued` before the callback observation;
10. any synchronous throw site yields at most one constructive closed error.

Custom shrinkers retain the first competing terminal claims, kill position,
active token, and failing synchronous site while deleting unrelated events.

## 3. Body partition and cap model

Generate arbitrary byte arrays, response limits, and chunk partitions. For
length <= 12, enumerate every ordered partition, including empty physical
chunks; for larger arrays, generate boundary-heavy partitions around 1, limit-1,
limit, limit+1, and large single chunks.

Properties:

- all partitions at/below limit produce `Complete` with byte-for-byte equality;
- `RejectOverLimit` always fails on first proven excess and exposes no prefix;
- `TruncateOverLimit` always returns exactly the first `limit` bytes and
  `decodedLengthAtLeast = limit + 1`;
- no model state retains more than limit bytes;
- request Utf8/Binary constructors copy bytes and reject encoded size >8 MiB;
- mutating the fixture source buffer after dispatch cannot change request or
  response bytes;
- GET/HEAD with body and CONNECT/TRACE never dispatch.

UTF-8 fixtures compare Elm encoding byte length with Node `TextEncoder`, including
astral characters, combining text, lone surrogates under the pinned encoding
semantics, and the 8 MiB boundary.

## 4. URL/origin and error properties

Generate schemes, Unicode/ASCII/IPv4/IPv6 hosts, ports, user-info, percent forms,
paths, queries, fragments, and relative references. Compare package results to
the pinned Node WHATWG fixture oracle.

Properties:

- accepted URL is HTTP(S), fragment-free, no user-info, and round-trips to the
  same canonical request string;
- origin equality follows canonical scheme/host/effective port only;
- default ports collapse; non-default ports do not;
- IDNA, IPv6 brackets, path dots, and percent serialization match Node;
- resolving then policy-denying produces zero Fetch dispatch observations;
- `urlForDiagnostic` has no path/query/fragment/user-info;
- public error values/messages are constructible from only kind/site/allowlisted
  code; generated raw exception strings, secrets, URLs, headers, and body
  sentinels never appear;
- `urlToRequestString` explicitly does contain query and is never called by
  error/log paths (static grep plus runtime poison value).

## 5. Header and Node Fetch oracle

A raw `node:http` loopback server records `rawHeaders`, method, target, and body,
and emits explicit raw response header lines including duplicates. Generated
request header lists compare:

- package input order before `Headers`;
- Node 24 Fetch-normalized outbound behavior versus server `rawHeaders`;
- lowercase/canonical validation and forbidden-header rejection;
- duplicate ordinary response lines versus `headers.entries()` coalescing;
- ordered `getSetCookie()` values and absence of set-cookie from general headers;
- duplicate Location combinations exactly as visible to Node Fetch;
- automatic `accept-encoding`, visible `content-encoding`/`content-length`, and
  decoded response bytes;
- manual redirect `response.url` equals requested canonical URL;
- HEAD, 204, and 304 return `Complete empty` and perform no reader reads even if
  a fixture body object is injected.

The oracle is raw server observations, not a second Fetch wrapper.

## 6. Redirect reference properties

Generate graphs whose edges carry status, absent/empty/valid/invalid Location,
origin, delay, and policy decision. The pure adapter model follows only
301/302/303/307/308.

Properties:

- initial request has followed=0; exactly ten edges may be followed; the 11th
  edge returns `RedirectHopLimitExceeded` before dispatch;
- non-follow statuses, including 300 and 304, terminate normally;
- absent/empty Location on a follow status terminates normally;
- non-empty invalid/non-http(s)/user-info Location returns
  `RedirectInvalidLocation`;
- relative resolution matches WHATWG base resolution;
- every approved hop mints only that hop's singleton origin;
- denied target performs zero DNS/Fetch work;
- all requests are GET/Empty with accept/user-agent reapplied;
- one shared deadline decreases across network and Elm transition delays;
- redirect bodies are `DiscardedRedirectBody`, cause zero read calls, and do not
  consume final-body cap;
- every generated terminal state maps to exactly one `RedirectResult` constructor.

Shrinkers preserve the edge that crosses hop 10, escapes origin, becomes invalid,
or exhausts deadline.

## 7. Deterministic injected-operation machine

The fixture assembly uses the canonical production state machine with explicit
fake implementations for URL/Headers, clock/timer, AbortController, Fetch,
response facts, reader acquisition/read, body/reader cancellation, lock release,
byte copy, and delivery. Every operation can return, throw synchronously, settle
later, reject, or never settle where meaningful.

Generated scripts pause at:

- before/after dispatch;
- before/after physical response;
- no response body;
- before reader acquisition;
- reader idle;
- pending read;
- physical chunk/EOF/error;
- before/after terminal claim;
- before/after `CallbackQueued`;
- callback invocation/ack;
- kill at every point.

The fixture trace is compared step-for-step with the pure Elm machine. It asserts
one owner, exact verb counts, claim-before-abort, CallbackQueued-before-callback,
exception containment, idempotent cleanup, stale-token suppression, and no
production-style resource after terminal. Fake hooks record observations but do
not decide state transitions.

## 8. Compression and transient-memory fixtures

Raw local endpoints serve gzip, deflate, and Brotli bodies with:

- high expansion ratios;
- encoded chunks split at every small boundary;
- decoded length limit-1/limit/limit+1 and far above limit;
- truthful, false, and absent Content-Length;
- truncated/corrupt compressed streams;
- slow encoded delivery and timeout races.

Assertions use decoded bytes for cap outcomes and never infer from visible
encoded headers. Memory tests run in isolated Node processes with forced-GC
sampling where supported and record `heapUsed + external + arrayBuffers` at
baseline and peak. For each pinned fixture and concurrency, excess over retained
package bytes must fit the design's max(4 MiB/live response, 2x decoded limit)
envelope plus measured process baseline tolerance. This is labeled empirical.
Any regression blocks release; results never claim a strict heap proof.

## 9. Real compiler Task/Process.kill matrix

Separate `fixture-apps/` compile the package with the pinned Schelm compiler and
run generated debug and optimized JS. Workers expose ports only for test case
input and observations; package modules contain no fixture API.

For each local-server phase, an Elm worker runs:

```elm
Process.spawn (HttpClient.send origins deadline request)
    |> Task.andThen (\pid -> controlledDelay |> Task.andThen (\_ -> Process.kill pid))
```

Kill races cover pre-dispatch expired deadline, immediately after spawn, delayed
headers, no-body response, before reader, pending read, each chunk, physical EOF
before callback, callback queued before app acknowledgment, timeout, and cap
crossing. Assertions distinguish physical server receipt from logical Task
result. Killed-before-callback cases produce no result; queued-before-kill may
produce the already scheduler-owned result; neither duplicates. Server socket
closure is observed but not given a false instantaneous guarantee.

## 10. Differential WebFetch migration

Tests vendor a deterministic archive of legacy `http-kernel.js`, `web-fetch.js`,
and required narrow shims. Manifest includes source harness commit, each path,
SHA-256, archive SHA-256, and Node version. Verification runs offline before any
differential case. The legacy snapshot cannot import replacement production
modules.

Against identical local fixtures, compare legacy and new integrated Elm
WebFetch for:

- status and follow/non-follow decision;
- final URL modulo canonical fragment/spelling difference;
- 10-edge cap and total timeout class;
- retained decoded prefix, truncation flag, text/binary decision, content type;
- HTML/raw/text/markdown post-processing and tool envelope;
- error class and absence of secrets.

Only the five differences listed in revision B are accepted by named predicates.
Any other mismatch fails. On cutover, poison tests make host execution return
`POISONED_WEBFETCH_OLD_ROUTE`; end-to-end tool tests must still pass through the
Elm `RunWebFetch` effect. Static gates reject `runWebFetch`, WebFetch imports of
`http-kernel`, host dynamic import for WebFetch, or fallback RPC.

## 11. Harness ownership and interruption tests

Integration tests start the real compiled `ServerMain` worker and host shell,
submit WebFetch as a normal tool call, and assert:

1. tool-wave ownership/running state is unchanged;
2. `RunWebFetch` executes inside `StateMachine.applyEffects` as a direct Task;
3. no `rpcSend`/host tool invocation carries WebFetch;
4. completion enters the existing `ToolResolved` path exactly once;
5. interrupt/session close kills the stored owning Elm process and yields the
   existing interrupted/lost-in-flight semantics, not a detached late result;
6. daemon remains alive after one request failure;
7. poison old route is never touched.

The integration property model also generates `Starting`, pid arrival,
`Running`, completion, interrupt, and session-close orderings for the typed
`webFetchRuns` map. It proves cancellation-before-pid becomes
`CancelledBeforePid`, that the later pid is killed before removal, that stale
completion cannot resolve the tool, and that every non-awaiting terminal run is
absent. This is harness integration, not package API expansion.

## 12. 200-request complexity and leak gate

Run 200 concurrent loopback requests at concurrency schedules 1, 8, 32, and 200;
each response uses at least 10,000 generated chunks in the deterministic layer
and a practical high-chunk real-server variant. Instrument canonical operations,
not wall-clock alone.

Blocking assertions:

- one operation-table lookup per event; no scan of requests;
- one O(chunk bytes) inspect/copy per new chunk and no accumulated body concat
  until one final successful concat;
- no accumulated buffer sent through observations;
- transition/copy counts are linear in chunk count/bytes within exact formulas;
- package-owned retained bytes <= sum of live response limits;
- after terminal/kill, operation/resource maps are empty;
- timers, readers, controllers, sockets, handles, and heap return to bounded
  baseline after physical cleanup opportunities;
- event-loop delay and throughput are recorded; unstable absolute timing is a
  trend, while operation counts and leaks are blocking.

A diff grep rejects `acc ++ [ x ]`, `List.member` dedupe accumulators, per-chunk
full-list scans, and per-chunk `Buffer.concat`.

## 13. Artifact, provenance, and bounded-run gates

Pinned offline evidence includes:

- Schelm compiler commit and binary SHA-256, with honest integrity versus build
  reproducibility statement;
- package commit/tree and deterministic archive SHA-256;
- public package seed manifest and hashes;
- exact Node 24 executable/version/archive SHA-256 used by CI;
- frozen legacy differential archive provenance;
- generated debug/optimize worker hashes tied to sources.

Cold and warm builds use fresh per-invocation isolated `ELM_HOME`; bootstrap may
use only verified immutable cache artifacts and an exclusive population lock.
Ambient Elm/npm caches are poisoned in CI to prove non-use.

Production artifact inspection fails on fixture names, hook markers, fake
transport, observation arrays, diagnostics registries/timers, source-map secret
leaks, or unpinned dependencies. Fixture apps are outside package source dirs.

Default shard deadline is 60 seconds; compression/memory and 200-request shards
may use an explicitly declared 180 seconds. A top-level 15-minute supervisor
kills all descendant process groups and prints unfinished shard/seed. Local
servers bind loopback ephemeral ports and close on success, failure, signal, and
timeout. No retry hides a deterministic failure.

## 14. Release criterion

Release and harness cutover require every property layer, debug/optimize matrix,
artifact gate, offline provenance check, frozen differential suite, poison-route
end-to-end test, 200-request complexity gate, and bounded supervisor run to pass.
A skipped or zero-case suite is failure. Streaming/SSE/LLM tests are absent
because those features are absent, not silently implemented without design.
