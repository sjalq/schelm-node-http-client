# 05 — Final design revision B

Status: final design. This supersedes conflicting details in 01 and 03. Source
implementation remains prohibited until this and `06-property-test-plan.md` are
committed and pushed.

## 1. Frozen scope

V1 is one-shot buffered `Task` HTTP on pinned Node 24 global Fetch. It has no
`Cmd` API, effect manager, stream handle, upload stream, SSE, LLM/provider,
credential, multipart, retry, automatic redirect, or HTML policy. Those are
separate future designs.

The first and only v1 harness cutover is WebFetch. Request method is always GET
and body always empty in that adapter. The general package accepts the bounded
method/body combinations below, but no other harness consumer is migrated in
this slice.

## 2. Final public invariants

```elm
type OriginSet                         -- cooperative, publicly mintable
type Url                               -- canonical http(s), fragment-free
type Request                           -- opaque, exactly one copied Body
type Response                          -- opaque
type RequestHeader                     -- validated caller input
type ResponseHeader                    -- Fetch-visible normalized fact

type ResponseBody
    = Complete Bytes                   -- exact bytes; exact length = Bytes.width
    | Truncated { prefix : Bytes, decodedLengthAtLeast : Int }
    | DiscardedRedirectBody

responseBody : Response -> ResponseBody
status : Response -> Int
statusText : Response -> String
headers : Response -> List ResponseHeader
setCookies : Response -> List String
responseUrl : Response -> Url

send : OriginSet -> Deadline -> Request -> Task Error Response
```

`Response` has a private constructor. `Complete`, `Truncated`, and
`DiscardedRedirectBody` are the only body states; length metadata cannot disagree
with the body. `Truncated.decodedLengthAtLeast` is exactly `limit + 1`, the first
proven excess byte, never a guessed total. A reject-over-limit request returns
`ResponseTooLarge` and no `Response`.

`Request` stores exactly one `Empty | Utf8 | Binary` body. Body input is copied
into package-owned bytes during construction. UTF-8 size is encoded bytes.
Request bodies over 8 MiB fail before dispatch. GET and HEAD require Empty;
CONNECT and TRACE are rejected; other valid RFC token methods retain their
canonical uppercase spelling. Fetch receives no `body` member for Empty. The
WebFetch adapter constructs only GET/Empty, including every redirect hop.

## 3. URL and cooperative-origin contract

Parsing/resolution is pinned to Node 24 WHATWG `URL`: only absolute HTTP(S)
results; no username/password; lowercase scheme/host; WHATWG IDNA ASCII host;
bracketed IPv6; default-port elision; WHATWG percent serialization and dot-path
resolution; query retained; fragment forcibly removed; origin equality is exact
serialized `URL.origin`.

`urlToRequestString : Url -> String` intentionally returns the full canonical
request URL **including query**. It is marked secret-bearing and forbidden in
logs/errors. `urlForDiagnostic : Url -> String` returns only
`scheme://host[:port]/<redacted>`. There is no ambiguously named `toString`.

`OriginSet` is an opaque finite non-empty set but publicly mintable pure data.
It is cooperative dependency scoping, not a capability sandbox. It does not
prevent SSRF, DNS rebinding, private/loopback destinations, resolver changes, or
malicious linked code. Harness egress policy remains sole owner. A disallowed
origin causes zero DNS/Fetch work.

## 4. Request and response headers; pinned Fetch semantics

Request names are validated tokens and canonicalized lowercase. Values reject
NUL/CR/LF. A fresh `Headers` receives `append` calls in Elm list order. The
observable outbound contract is Node 24 WHATWG normalization/coalescing, not raw
line multiplicity. Framing/hop-by-hop headers and all cookie/auth/proxy-auth
headers are unconstructible. WebFetch sets only `accept` and `user-agent`.

Node Fetch may automatically add `accept-encoding` and decompress gzip/deflate/
br. V1 does not set or promise suppression of it. Response body bytes are
decoded bytes, while visible `content-encoding` and `content-length` remain the
headers Node Fetch exposes and may describe encoded wire representation. Callers
must not compare those values to decoded body length.

Response general headers are exactly `Response.headers.entries()` in iterator
order: lowercase normalized names and Fetch-coalesced values. `set-cookie` is
excluded there and exposed only through ordered `getSetCookie()` values. A raw
Node HTTP server records actual request raw headers and emits controlled raw
response lines; that server is the oracle for supported Node 24 behavior.

A coalesced `location` is one Fetch-visible string. The adapter accepts it only
if URL resolution succeeds. It does not split commas or attempt to reconstruct
multiple raw Location lines. Thus duplicate Location follows whatever single
normalized value Node exposes, usually becoming invalid if coalesced; tests pin
this.

Fetch runs `redirect: "manual"`. `responseUrl` is parsed from `response.url` if
non-empty; under the pinned Node runtime manual responses are expected to report
the requested canonical URL, and fixtures enforce equality. A mismatch is
`UnsupportedRuntime`, not silently accepted.

HEAD, 204, and 304 are bodyless by HTTP/Fetch semantics. The machine cancels any
unexpected body object without reading and returns `Complete empty`. A manual
301/302/303/307/308 with accepted non-empty Location and request flag
`discardRedirectBody` returns `DiscardedRedirectBody` after non-awaited,
exception-contained cancellation. Other statuses read normally.

## 5. Total redirect algebra and exact hops

The ordinary Elm WebFetch adapter follows exactly `301`, `302`, `303`, `307`,
and `308`. It never follows other statuses. Since WebFetch is GET/Empty, every
hop remains GET/Empty; generic RFC method rewriting is intentionally absent.

```elm
type RedirectResult
    = RedirectFinished Response
    | RedirectInvalidLocation { status : Int, at : Url }
    | RedirectHopLimitExceeded { last : Url, followed : Int }
    | RedirectPolicyDenied Url
    | RedirectDeadlineExceeded
    | RedirectTransportFailed Error

type RedirectState
    = NeedRequest { url : Url, followed : Int, deadline : Deadline }
    | RedirectDone RedirectResult
```

The initial request has `followed = 0`. A followed edge increments it. At most
10 edges may be followed, so up to 11 requests occur. If a followable response
arrives when `followed == 10`, result is `RedirectHopLimitExceeded` and no next
request occurs. A followable status with absent/empty Location is a final
ordinary response, preserving legacy behavior. A non-empty but unresolvable,
non-http(s), or user-info Location is `RedirectInvalidLocation`. Each resolved
target runs harness policy before a dynamic singleton OriginSet is minted; denial
means no dispatch. All hops share one total deadline. Redirect bodies identified
above are discarded before the Task returns and never consume final-body cap.

## 6. Decoded cap and honest memory contract

The response limit is 1..8 MiB; WebFetch uses at most 2,000,000 decoded bytes.
Cap accounting is on decoded `Uint8Array` chunks delivered by Undici. Package-
owned retained bytes never exceed the limit. On a crossing chunk, only remaining
prefix bytes are copied; at least one excess byte is observed; then logical
terminal/truncation is claimed before abort/cancel.

This is **not a strict process-heap cap**. Undici/zlib/V8 may allocate encoded
buffers, decompressor state, and a decoded chunk before package code sees it.
The pinned Node artifact receives a measured transient-overhead contract:
for fixture encodings and chunk schedules up to the package hard limit, peak
`heapUsed + external + arrayBuffers` above retained package bytes must be no more
than the recorded baseline plus **4 MiB per live response or 2x decoded limit,
whichever is larger**. This is an empirical regression envelope, not a security
proof. If the pinned runtime exceeds it, CI fails and release is blocked; the
limit is not loosened silently. Inputs crafted beyond measured fixtures may use
more transient memory. A future strict heap guarantee requires a reviewed
lower-level transport/decompressor with bounded output buffers.

`Content-Length` never proves decoded size and is ignored for cap decisions.
Truncation stops at first proven excess and reports only `limit + 1` lower bound.

## 7. Deadline, terminal, delivery, and cleanup

A deadline uses monotonic milliseconds. Construction accepts integer timeout
1..120000. For dispatch:

```text
remaining = deadlineMonotonic - nowMonotonic
if remaining <= 0: claim DeadlineExceeded; no timer; no Fetch
else delay = max 1 (ceiling remaining), capped at 120000
```

Timer firing first calls `claimTerminal DeadlineExceeded`; only the winner then
calls abort/cancel. Therefore abort rejection cannot replace timeout. Cap failure
and process kill use the same claim-before-verb order. EOF/error/timer/kill races
have one logical winner.

Canonical resource ownership is explicit:

```text
BeforeResponse { abort, timer }
ResponseNoBody { abort, timer, maybeBody }
BeforeReader { abort, timer, body }
ReaderIdle { abort, timer, reader }
ReadPending { abort, timer, reader, readToken }
ReaderEnded { abort, timer }
CallbackQueued
Abandoned
Absent
```

Cleanup is idempotent and exception-contained in every state:

- before response: clear timer, abort;
- no body / before reader: clear timer, cancel body if available;
- reader idle or pending: clear timer, abort, invoke reader cancel without await,
  release lock where legal, drop chunks;
- EOF: release lock, clear timer, drop transport references;
- callback queued: no package resource remains;
- repeat/stale cleanup: no-op.

Every cleanup verb is wrapped; returned rejecting promises get a local rejection
handler and are never retained. Production has no diagnostics registry, cleanup
timer, hook array, or retained settled operation. Physical socket/decompressor
cleanup may lag logical absence; no callback waits for it.

`Scheduler.binding` returns the kill function synchronously. Kill first claims
`Abandoned`, then cleans. It emits no Task error. `CancelledByProcess` is absent
from the public error type. If callback was already queued, Process.kill cannot
retract the scheduler-owned result.

Before calling the scheduler callback, state is set to `CallbackQueued` and all
resources are dropped. Callback invocation is the last operation and is wrapped;
a synchronous callback throw is swallowed after state is already terminal and
cannot cause a second callback.

## 8. Complete synchronous-exception boundary

One canonical machine wraps each synchronous operation independently:

- URL construction/serialization and origin check;
- request-byte copy, Headers construction/append, AbortController creation;
- monotonic clock, timer set/clear;
- Fetch invocation (including a synchronous throw before Promise return);
- response status/text/url/body access and header iteration/getSetCookie;
- body `getReader`, `read`, byte view/copy/concat;
- body/reader cancel, abort, lock release;
- scheduler delivery callback.

Unknown exceptions are mapped by operation site to a closed error kind; raw
`message`, `stack`, `cause`, URL, headers, and bodies are never copied. Public
errors are constructed only from `ErrorKind`, a fixed site label, and an
allowlisted Node/Undici code. Messages are fixed templates under 512 characters.
Codes outside the allowlist become absent. HTTP status remains success.

## 9. Canonical implementation and artifact separation

The canonical transaction accepts explicit injected operations:

```text
parseUrl, makeHeaders, copyBytes,
nowMonotonic, setTimer, clearTimer,
makeAbortController, abort,
fetchManual, responseFacts, acquireReader, read,
cancelBody, cancelReader, releaseReader,
deliverSuccess, deliverFailure
```

The canonical source owns all state/terminal/cap/cleanup logic. Production
assembly binds Node 24 Fetch and Elm scheduler values. Fixture assembly binds a
deterministic scripted transport and event recorder at marked observation sites.
It can pause before/after physical dispatch, response, read settlement, terminal
claim, delivery queueing, and kill.

Production and fixture generated kernels are separate. A blocking artifact test
proves production lacks fixture module names, hook markers, event recorders,
fake operations, diagnostics maps, and test imports. The fixture is an app-only
dependency; package API exposes none of it.

## 10. Actual harness execution and cutover

Current WebFetch runs outside Elm: `Tools` emits a normal `RunTool`,
`Rpc.Tool.run` sends it through ConcurrentTask ports, and `tools-impl.js` imports
`web-fetch.js`/`httpFetch`. The new boundary is explicit:

1. `Effect` gains `RunWebFetch { agentId, call, args }` and `Msg` gains a typed
   `WebFetchTaskFinished` result.
2. Tool-wave dispatch in ordinary Elm recognizes only the exact `WebFetch` tool
   after existing `ToolPolicy`/argument decoding, records the same running tool
   ownership, and emits `RunWebFetch` instead of `RunTool`.
3. `StateMachine.applyEffects` executes `WebFetch.Transport.run` directly as an
   Elm `Task` using this package, then maps completion to the existing
   `ToolResolved` result path. It runs inside the long-lived `ServerMain`
   `Platform.worker`; no Node tool executor or RPC port participates.
4. Integration adds `webFetchRuns : Dict ToolCallId WebFetchRun` to the session
   model, where `WebFetchRun = Starting | Running Process.Id |
   CancelledBeforePid`. Start inserts `Starting`, then runs
   `Process.spawn (Task.attempt (WebFetchTaskFinished id) task)` and reports
   `WebFetchProcessStarted id pid`. `Started` changes `Starting` to `Running`;
   if completion already removed the entry it immediately kills the stale pid;
   if state is `CancelledBeforePid` it kills then removes. Interrupt changes
   `Starting` to `CancelledBeforePid`, kills/removes `Running`, and ignores any
   completion not owned by a live entry. Completion removes `Starting`/`Running`
   and enters `ToolResolved`; completion in `CancelledBeforePid` is ignored while
   retaining that tombstone until the pid arrives. Thus the unavoidable async
   pid handoff is represented, no request detaches, and a late pid/result cannot
   revive a cancelled call. Settled normal/running entries are absent.
5. `Tools.finalizeHost` is split so typed Elm WebFetch facts enter the same
   presentation reducer without pretending they came from host JSON.

At cutover, `tools-impl.js`'s WebFetch branch throws a fixed
`POISONED_WEBFETCH_OLD_ROUTE` error in test and production builds, then is deleted
once no caller references it. `web-fetch.js` and the WebFetch-only exports/tests
are deleted; `httpFetch` remains only for a checked list of unmigrated non-
WebFetch consumers. A grep/artifact gate rejects `runWebFetch`, WebFetch imports
of `http-kernel`, and host execution of a WebFetch tool.

Differential tests vendor a frozen legacy `http-kernel.js` + `web-fetch.js`
snapshot as a deterministic archive with commit, file list, and SHA-256. It is
loaded only by tests and cannot import mutable production modules except a
narrow test shim. Hash mismatch fails before comparison.

## 11. Closed list of intentional WebFetch differences

Only these differences are allowed at cutover:

1. URL serialization follows the pinned Node 24 WHATWG canonical string and
   fragments are removed before dispatch; legacy incidental spelling may differ.
2. Oversized responses report a decoded lower bound (`limit + 1`) rather than
   draining an unknown-length stream to compute an exact total. Visible retained
   prefix and `truncated = True` remain equal.
3. Duplicate/coalesced Location is interpreted as Node Fetch's one normalized
   value and is never comma-split; malformed normalized values become typed
   invalid-location errors.
4. Timeout classification is deterministic `DeadlineExceeded` when the timer
   wins, rather than whichever AbortError/network text races first.
5. Error wording is fixed constructive text and never includes raw Node exception
   messages or full URLs.

Status, final URL modulo item 1, redirect status set/hop cap, content bytes,
HTML/binary processing, cap prefix, headers used by WebFetch, and success/error
class must otherwise match. Any unlisted differential mismatch blocks cutover
and requires another design revision.

## 12. Final error algebra

```elm
type ErrorKind
    = InvalidRequest
    | OriginNotAllowed
    | DeadlineExceeded
    | ResponseTooLarge
    | NetworkFailure
    | UnsupportedRuntime
    | UnknownFailure
```

No cancellation constructor exists. Errors carry only kind, closed site, and
optional allowlisted code. Streaming/SSE/LLM and auth remain explicitly deferred.
