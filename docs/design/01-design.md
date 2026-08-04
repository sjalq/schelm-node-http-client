# 01 — `schelm-node-http-client` v1 design

Status: first-turn design only. No implementation is authorized by this artifact.

## 1. Goal, first slice, and non-goals

V1 is a small Node-only Elm kernel package for bounded HTTP client mechanics. It
will replace one buffered agent-harness path first: preferably the unauthenticated
`WebFetch` transport (and then compatible buffered `Rpc.Http` calls). Provider
schemas, WebFetch presentation, HTML reduction, retries, SSE framing, redirect
policy, credential lookup, and LLM accumulation remain ordinary harness code.
LLM streaming is deliberately the second slice, after buffered differential
parity.

The target is Node 24 and the private Elm 0.19.2 compiler fork. Applications
still cannot contain or import `Elm.Kernel.*`; only authorized `sjalq` packages
can.

V1 non-goals: browser HTTP, cookies/cache jars, proxies, automatic retry,
automatic redirects, decompression policy controls, HTTP/2 selection, TLS/client
certificate configuration, multipart construction, SSE parsing, provider auth,
disk-backed bodies, and unbounded bodies. Request upload streaming is deferred:
the first streaming need is a buffered JSON request with a streamed response.

## 2. Proposed public shape

Names may change after hostile review, but the boundaries may not silently grow.

```elm
module Schelm.Node.HttpClient exposing
    ( Permission, Host, HostError(..), host, authorizeForHosts
    , Method, method, MethodError(..)
    , Header, header, HeaderError(..)
    , Body, emptyBody, utf8Body, bytesBody
    , ByteLimit, byteLimit, LimitError(..)
    , Timeout, timeout, TimeoutError(..)
    , Request, request, withHeader, withBody, withTimeout
    , Response, Error, ErrorKind(..), errorKind, errorMessage
    , send
    , Stream, StreamEvent(..), stream, continue, cancel
    )


type Permission                 -- opaque, cooperative finite origin set
type Host                       -- opaque normalized http(s) origin
type HostError = InvalidHost | UnsupportedScheme | HostHasPath
host : String -> Result HostError Host
authorizeForHosts : Host -> List Host -> Init.Task Permission


type Method                     -- opaque RFC token, upper-cased once
method : String -> Result MethodError Method

type Header                     -- opaque validated name/value pair
header : String -> String -> Result HeaderError Header


type Body
    = EmptyBody
    | Utf8Body String
    | BytesBody Bytes

emptyBody : Body
utf8Body : String -> Body
bytesBody : Bytes -> Body


type ByteLimit                  -- positive and <= package hard maximum
byteLimit : Int -> Result LimitError ByteLimit

type Timeout                    -- positive finite milliseconds
timeout : Int -> Result TimeoutError Timeout


type Request                    -- opaque, always exactly one Body
request : Method -> String -> ByteLimit -> Result RequestError Request
withHeader : Header -> Request -> Request
withBody : Body -> Request -> Request
withTimeout : Timeout -> Request -> Request


type alias Response =
    { status : Int
    , statusText : String
    , headers : List Header
    , url : String
    , body : Bytes
    , receivedBytes : Int
    }

send : Permission -> Request -> Task Error Response


type Stream                     -- opaque live handle; kernel registry key
type StreamEvent
    = ResponseStarted Stream { status : Int, statusText : String, headers : List Header, url : String }
    | Chunk Stream Bytes
    | Complete { receivedBytes : Int }
    | Failed Error
    | Cancelled

stream : Permission -> (StreamEvent -> msg) -> Request -> Cmd msg
continue : Stream -> Cmd msg
cancel : Stream -> Cmd msg
```

`Request` contains one `Body`, defaulting to `EmptyBody`; there are no parallel
`bodyText`/`bodyJson`/`bodyMultipart` options and therefore no invalid “two
bodies” value. JSON is `Json.Encode.encode` plus `utf8Body`; multipart waits for
a real consumer. A GET/HEAD body is rejected by the ordinary Elm constructor or
final validator rather than silently dropped.

The buffered result is bytes, not a JavaScript-decoded string. This makes the
byte cap exact and avoids pretending arbitrary HTTP bytes are UTF-8. A small
ordinary Elm helper module may expose strict UTF-8 decoding. Malformed UTF-8
must produce a decoding error; replacement decoding is a separately named
caller choice, never an implicit kernel behavior. The initial WebFetch adapter
will choose and test the legacy-compatible replacement behavior explicitly.

## 3. Cooperative host permission — honest authority

A `Permission` holds a non-empty, finite set of normalized origins:
`scheme://ascii-host:effective-port`. User-info, path, query, fragment,
wildcards, IP ranges, and non-http(s) schemes are rejected. Every request URL is
parsed in the kernel and checked against the permission immediately before
network dispatch. Every redirect is a new request and is checked again.

This is **cooperative scoping**, not a hostile-code sandbox. Any linked Elm
module that imports this public package can call `authorizeForHosts` during
initialization. As with the filesystem package, Elm currently lacks Gren's
compiler-enforced trusted bootstrap boundary. The value prevents accidental
cross-host use and makes authority visible in types; it does not constrain
malicious application code. The harness composition root will acquire distinct
permissions and pass them only to owners. Kernel JS must not invent wildcard or
ambient permission.

No request API accepts a credential reference in v1. Secret values must not
enter Elm, generated JavaScript literals, logs, errors, fixtures, archives, or
manifests. Consequently the first migration is an unauthenticated WebFetch
transport. Authenticated `Rpc.Http`/provider migration is blocked until an
independently reviewed host credential-injection capability can resolve an
opaque reference outside Elm without turning the package into a credential
policy owner. Passing `Catalog.AuthSpec` or environment/file names into this
package is explicitly not part of v1.

## 4. Headers and redirects

Headers are represented as an ordered `List Header`; duplicate request names are
retained in Elm. Header names are case-insensitive for lookup but original value
bytes are not trimmed or joined. NUL, CR, and LF are rejected. Hop-by-hop and
Fetch-forbidden headers are rejected with a typed error before dispatch rather
than silently rewritten.

The Node 24 global `fetch` API is backed by Undici but its WHATWG `Headers`
interface coalesces many duplicate response fields. It cannot reconstruct wire
multiplicity after coalescing. V1 therefore promises **Fetch-visible
multiplicity**, not raw-wire fidelity: `set-cookie` is emitted once per
`getSetCookie()` value when available; other names are emitted exactly as the
Fetch `Headers` iterator exposes them, which may be one comma-combined value.
Tests pin this behavior. Callers needing raw `rawHeaders` semantics are outside
v1. We will not claim that `List Header` means raw-wire preservation.

The kernel always uses `redirect: "manual"`. `send` returns 3xx like any other
response. Harness Elm owns hop count, shared wall-clock budget, relative
`Location` resolution, method/body rewrite rules, and cross-origin stripping of
`authorization`, `cookie`, and other sensitive headers. A redirect target not
in the supplied `Permission` fails before dispatch. This avoids Fetch's hidden
redirect chain, where intermediate hosts and sensitive-header decisions would
become unobservable.

## 5. Node 24 Fetch/Undici boundary

Kernel JavaScript performs only these verbs/facts:

1. validate the already typed runtime representation defensively;
2. check the normalized URL origin against the opaque permission;
3. create one `AbortController` and wall-clock timer;
4. call Node 24 `globalThis.fetch` with `redirect: "manual"`;
5. expose status, final URL, Fetch-visible headers, and byte chunks;
6. cancel/release the reader and settle exactly once.

V1 does not import an ambient npm `undici` package: that would add an unpinned
runtime authority outside Elm package provenance. The exact supported Node 24
minor is pinned in fixture/toolchain metadata because global Fetch behavior is
part of the ABI. If raw header multiplicity or dispatcher control later requires
the public Undici module, it must be a pinned offline artifact and a separately
reviewed boundary, not an opportunistic `require("undici")`.

Fetch automatically decodes supported content encodings. The response byte cap
therefore applies to **decoded bytes delivered by the response stream**, the
bytes that consume process memory and reach Elm. `Content-Length` is only a
fact; it cannot waive or redefine the cap. DNS rebinding/IP allowlists are not
claimed: v1 scopes textual origins, not resolved network ranges.

## 6. Buffered state machine and byte cap

The hard package maximum is fixed and documented (proposed 8 MiB); every request
also carries a positive lower/equal `ByteLimit`. No unbounded constructor exists.

```text
Prepared
  -- dispatch --> AwaitingResponse(owner, abort, deadline, cap)
  -- response --> Reading(owner, reader, keptChunks, keptBytes, receivedBytes)
  -- cancel/timeout/network error -------------------------------> Terminal(error)

Reading
  -- physical read <= remaining --> Reading(updated counters)
  -- physical read crosses cap --> CancellingLimit(reader)
  -- end with bytes <= cap ------> Terminal(success)
  -- cancel/timeout/read error ---> Terminal(error)

CancellingLimit
  -- physical cancel settles or bounded cleanup deadline --> Terminal(LimitExceeded)
```

The cap is fail-closed: unlike current WebFetch truncation, `send` returns
`LimitExceeded` and no partial `Response`. A higher ordinary Elm adapter may
implement explicit truncation using streaming, but truncation cannot masquerade
as a complete body. At most `cap + one transport chunk` is transiently visible
to JS; only `cap` bytes are retained. `Buffer.concat` occurs once at successful
terminal settlement. `Content-Length > cap` may fail and cancel immediately,
but missing/false lengths are still enforced while reading.

Cancellation is cooperative because Node/Undici may already have performed
network work. It guarantees no later Elm success/chunk event, not that bytes
were never sent. Reader cancel has a bounded cleanup wait; terminal notification
does not hang forever on an uncooperative transport.

## 7. Streaming, acknowledgement, and backpressure

The response-stream machine allows one delivered-but-unacknowledged chunk and
one terminal event only:

```text
Starting
  -- headers physically received --> DeliveringHeaders
DeliveringHeaders
  -- Elm callback acknowledged ---> ReadyToRead
ReadyToRead
  -- continue --------------------> ReadingOne
ReadingOne
  -- reader.read physically yields bytes --> DeliveringChunk
  -- physical EOF -------------------------> DeliveringTerminal(Complete)
  -- physical failure ---------------------> DeliveringTerminal(Failed)
DeliveringChunk
  -- Elm callback acknowledged ---> AwaitingContinue
AwaitingContinue
  -- continue --------------------> ReadingOne
Any live state
  -- cancel/timeout -------------> Cancelling
Cancelling
  -- reader/controller cleanup or deadline -> DeliveringTerminal(Cancelled/Failed)
DeliveringTerminal
  -- Elm callback acknowledged ---> Absent (registry entry deleted)
```

“Physically received/read/cancelled” and “Elm callback acknowledged” are
separate facts. Scheduling `sendToApp` is not an acknowledgment. No next read is
issued until the event task has actually crossed the scheduler callback and,
for chunks, the owner calls `continue`. Duplicate/stale `continue` and `cancel`
commands are idempotent no-ops; they cannot resurrect an absent stream. A stream
id has one registry owner and one terminal transition. Timeout, EOF, abort,
reader error, callback completion, and cancellation race through one settlement
function; terminal settlement deletes the registry entry.

`ResponseStarted` must be acknowledged before reading. Each physical chunk is
copied once into an Elm `Bytes` value, delivered once, and then forgotten before
the next read. This bounds unread retained data to one transport chunk. The
cumulative `receivedBytes` counter is O(1) and fails the stream with
`LimitExceeded` before delivering bytes beyond the request cap. Backpressure is
application-controlled and does not rely on a fast Elm mailbox.

Streaming upload is absent, so `continue` is unambiguously response demand. SSE
framing remains ordinary Elm and consumes arbitrary byte boundaries; no kernel
SSE parser is introduced.

## 8. Error algebra and terminal ownership

`Error` is opaque and exposes a closed mechanism-level kind:

```elm
type ErrorKind
    = InvalidRequest
    | HostNotPermitted
    | NetworkFailure
    | TimeoutExceeded
    | LimitExceeded
    | CancelledByCaller
    | InvalidUtf8        -- helper decoding, not Fetch
    | UnsupportedRuntime
    | UnknownFailure
```

HTTP 4xx/5xx are successful `Response` facts; callers own status policy. Raw JS
exceptions never cross as typed success. Errors expose a bounded sanitized
message and optional stable Node/Undici code; they never include request header
values, body bytes, query strings, or credential material. Diagnostic URLs are
origin plus redacted path, never query/user-info.

The kernel registry owns controller, timer, reader, callback state, and terminal
settlement. Timers are cleared, reader locks released/cancelled, references
dropped, and entries deleted on every terminal route. There is no second cleanup
owner in Elm.

## 9. Complexity and resource budget

For chunk `k` of size `m`, hot work is O(m), independent of earlier chunks,
requests, sessions, or total stream bytes. Counters and state transitions are
O(1). Buffered retention is O(cap); streaming retention is O(one chunk). No hot
path concatenates accumulated text/bytes, scans all stream entries, snapshots an
accumulated body, or sends an accumulated delta. A `Map`/object lookup by stream
id is O(1) expected.

At stream chunk 10,000 and session 200, the package performs one registry lookup,
one bounded copy, and one callback. SSE decoding/LLM accumulation costs are not
hidden in this package and must separately satisfy the harness O(chunk) law.

## 10. Gren 6.1.3 comparison

The reference inspected is the embedded `gren-lang/node` 6.1.3 package in the
Gren compiler checkout.

| Gren `HttpClient` | Schelm v1 decision |
|---|---|
| `initialize` and `initializeForHost` return `Init.Task Permission` | Mirror host-scoped cooperative permission, but explicitly admit that Elm's public initializer is weaker than Gren's trusted init boundary. No ambient “any host” initializer in v1. |
| `RequestConfiguration` has one `Body` (`Empty`, `String`, `Bytes`, `Stream`) | Keep exactly one body. V1 omits upload stream and JSON constructor; JSON is ordinary Elm encoding. |
| Headers are `Dict String (Array String)` with duplicate support | Use ordered `List Header`; document Node Fetch's response coalescing instead of claiming raw multiplicity. |
| `Expect` selects string/json/bytes/stream | Kernel returns bytes or a byte stream; decoding and provider schemas stay ordinary Elm. |
| `send` supports buffered and stream bodies | V1 buffered send plus streamed response only, always byte-capped. |
| Deprecated command streaming allows sending chunks and receiving chunks | Do not copy the deprecated API. Demand-driven one-chunk acknowledgement provides explicit backpressure and one terminal owner. |
| Kernel implementation uses Node Fetch for modern send and legacy Node request APIs for deprecated stream | Use one Node 24 global Fetch/Undici boundary; do not retain two HTTP authorities. |

We follow Gren where it provides a proven capability/body model, and narrow it
where Elm cannot honestly encode the same initialization authority or the
harness does not yet need upload streaming.

## 11. DRY migration plan

1. Build package fixtures and differential tests without changing harness
   production.
2. Migrate unauthenticated buffered WebFetch transport behind one Elm adapter.
   Run old `httpFetch` and package requests against the same local fixture
   server and compare status, final URL, Fetch-visible headers, decoded bytes,
   timeout, redirect, and cap behavior. Intentional differences (fail-closed cap
   versus truncation) are asserted, not normalized away.
3. Migrate only compatible unauthenticated `Rpc.Http` callers. Authenticated
   callers remain old until the separate secret-capability design exists.
4. Remove the migrated old buffered authority after bounded differential
   evidence. Do not permanently dual-run production network requests.
5. Only then integrate streaming beneath provider readers, leaving provider
   schemas and SSE in Elm. Differential local fixtures replay fragmented SSE;
   no real provider request is duplicated.

There will be one redirect policy (Elm), one cap authority (package request), one
stream registry (kernel), and one provider/SSE interpretation (ordinary Elm).
The package must not clone `WebFetch` rendering or `Catalog` auth policy.

## 12. Executable evidence from day one

Implementation may begin only after all six design artifacts exist. When it
does, the first commit must establish real compiler artifacts and executable
fixtures, not source-shaped evidence:

- package sources remain a package; app workers live under separate
  `fixture-apps/<case>/` applications with their own `elm.json`;
- compile and run every public operation through the pinned Schelm compiler in
  debug and `--optimize`; inspect generated kernel ABI and execute generated JS;
- cold and warm builds use isolated per-invocation `ELM_HOME`, never ambient
  `~/.elm` or ambient npm caches;
- compiler/package/Node artifacts and source archives have offline-verifiable,
  immutable commit and SHA-256 provenance; a binary hash alone is integrity, not
  a false reproducible-build claim;
- fault/event hooks are assembled only into fixture kernel artifacts. Production
  kernel output has a mechanical gate proving fixture symbols and hook markers
  absent;
- every test process, reader, callback, local server, and property shard has a
  hard deadline and teardown; bounded failure is preferable to a hanging suite.

## 13. Non-trivial property/state-machine tests

The later `06-property-test-plan.md` will refine generators and shrinkers, but
these are required executable properties, not inert prose or example-only tests.

### Pure Elm model

Generate valid/invalid hosts, URLs, methods, duplicate headers, body bytes,
limits, redirect graphs, and command traces:

```text
Start | Headers | PhysicalChunk bytes | DeliveryAck | Continue | Cancel
| Timeout | PhysicalEof | PhysicalError | CleanupAck | Stale event
```

Compare every trace with a pure state model. Properties:

1. exactly one terminal event and no event after terminal;
2. at most one physical read and one delivered unacknowledged chunk;
3. no `continue` before delivery acknowledgment can start an extra read;
4. cancellation at every state is idempotent and eventually absent;
5. total delivered bytes never exceeds cap; buffered success equals exact input
   bytes iff total is within cap;
6. host scope is preserved across relative, absolute, cyclic, and cross-origin
   redirects; sensitive headers never survive a caller-authorized cross-origin
   rewrite;
7. duplicate request headers retain order, while response assertions match the
   explicitly limited Fetch-visible multiplicity contract;
8. strict UTF-8 accepts precisely valid generated byte sequences and rejects
   malformed/truncated multibyte sequences independent of transport chunking.

Shrinkers preserve the first cap crossing, first terminal race, missing callback
acknowledgment, redirect edge that escapes scope, or malformed UTF-8 boundary
while deleting unrelated events.

### Deterministic kernel machine

A fixture-only fake Fetch/reader scripts delayed physical reads, callback
acknowledgments, cancel rejection/hang, EOF/error/timeout races, false
`Content-Length`, reused chunk buffers, malformed headers, and stale ids.
Generated schedules compare kernel observations to the pure model. Tests assert
physical-versus-ack distinction, one registry owner, one terminal callback,
reader/timer cleanup, copied bytes despite source-buffer reuse, and bounded
cleanup deadlines.

### Real Node 24 and differential harness

A local fixture server emits duplicate headers, redirect loops/chains, delayed
headers, slow and oversized chunked bodies, wrong/missing lengths, invalid UTF-8,
connection resets, and fragmented SSE at every byte boundary. Real compiled Elm
workers run debug and optimize matrices and cancellation races. Old harness and
new package are compared only against this deterministic server, avoiding
external flakiness and duplicate real side effects.

Artifact gates fail if a property module is merely compiled but never executed,
if production artifacts contain fixture hooks, if generated debug/optimize
workers are absent/stale, if tests consult ambient caches, or if any shard exceeds
its deadline.

## 14. Open questions for adversarial review

1. Is a public `Init.Task` initializer possible in the current Elm fork without
   overstating Gren-equivalent authority, or should the compiler gain a trusted
   bootstrap boundary before release?
2. Should the hard cap be 8 MiB, and is one Undici transport chunk of transient
   overhead sufficiently bounded on pinned Node 24?
3. Can scheduler callback completion be observed reliably enough to constitute
   delivery acknowledgment in both debug and optimize output, or must the public
   event include an explicit opaque acknowledgment token?
4. Does initial WebFetch need explicit truncating-stream adapter semantics before
   cutover, or should its visible behavior intentionally change to cap failure?
5. Is Fetch-visible header multiplicity sufficient for all first-slice callers,
   or should those callers be excluded until a pinned low-level Undici boundary
   is designed?
6. What opaque host credential reference can integrate harness file/OAuth auth
   without exposing secrets to Elm or making this package own credential policy?

Until those questions survive two independent reviews, this document authorizes
no implementation.
