# 03 — Design revision A

Status: supersedes conflicting parts of `01-design.md`. Review A rejects source
implementation; this revision does not authorize it. V1 is now one-shot buffered
`Task` transport only.

## 1. Narrow v1 and selected harness slice

V1 contains:

- exact WHATWG URL/origin parsing helpers;
- a publicly mintable cooperative `OriginSet`;
- one opaque request with exactly one bounded buffered body;
- one manual-redirect, buffered, decoded-byte-capped Node 24 Fetch request;
- a total-deadline value shared across sequential one-shot requests;
- Task/process cancellation through the Elm scheduler binding kill function;
- mechanism errors and Fetch-normalized response facts.

V1 does **not** contain `Cmd`, subscriptions, a stream registry, upload streams,
response streaming, SSE, multipart, JSON/provider schemas, credentials, retries,
HTML handling, or redirect policy. Streaming/SSE/LLM migration is deferred until
there is an independently reviewed compiler/effect-manager design that owns
mapping, routing, process/application lifecycle, cancellation, and backpressure.
A JavaScript registry is not an acceptable substitute.

The first harness cutover is **WebFetch's buffered transport**. The ordinary Elm
WebFetch adapter will own its redirect machine and presentation. After test-only
differential evidence, production `web-fetch.js` will no longer import or call
`httpFetch`; its Fetch/body-read/redirect mechanism will be deleted or reduced
to unrelated host glue. The old `Http:fetch` path may temporarily remain for
Media multipart/auth and session-index consumers, so this slice does not claim
to delete every use of `http-kernel.js`. The criterion is precise: no production
WebFetch request reaches `Rpc.Http`, `Http:fetch`, or `httpFetch`.

## 2. Revised public API

Illustrative names follow. Review B may refine names but not broaden lifecycle.

```elm
module Schelm.Node.HttpClient exposing
    ( Url, UrlError(..), url, resolve, toString, origin
    , Origin, OriginSet, originSet, allows
    , Method, MethodError(..), method
    , RequestHeader, RequestHeaderError(..), requestHeader
    , ResponseHeader, responseHeaderName, responseHeaderValue
    , Body, emptyBody, utf8Body, bytesBody, bodyByteLength
    , ResponseLimit, responseLimit, LimitError(..)
    , Timeout, timeout, TimeoutError(..), Deadline, startDeadline
    , OverLimit(..), DecodedLength(..), ResponseBody(..)
    , Request, RequestError(..), request
    , Response
    , Error, ErrorKind(..), errorKind, errorMessage, errorCode
    , send
    )


type Url                       -- canonical http(s), no user-info or fragment
type Origin                    -- canonical scheme/host/effective port
type OriginSet                 -- opaque, non-empty finite set
url : String -> Result UrlError Url
resolve : Url -> String -> Result UrlError Url
toString : Url -> String
origin : Url -> Origin
originSet : Origin -> List Origin -> OriginSet
allows : OriginSet -> Url -> Bool


type Method                    -- validated and canonical uppercase token
method : String -> Result MethodError Method

type RequestHeader             -- validated caller input
type ResponseHeader            -- Fetch-normalized response fact
requestHeader : String -> String -> Result RequestHeaderError RequestHeader
responseHeaderName : ResponseHeader -> String
responseHeaderValue : ResponseHeader -> String


type Body
    = EmptyBody
    | Utf8Body String
    | BytesBody Bytes

emptyBody : Body
utf8Body : String -> Result RequestError Body
bytesBody : Bytes -> Result RequestError Body
bodyByteLength : Body -> Int


type ResponseLimit             -- 1..8 MiB decoded bytes
responseLimit : Int -> Result LimitError ResponseLimit

type Timeout                   -- 1..120,000 ms total wall clock
timeout : Int -> Result TimeoutError Timeout
type Deadline                  -- opaque monotonic absolute deadline
startDeadline : Timeout -> Task Never Deadline


type OverLimit = RejectOverLimit | TruncateOverLimit
type DecodedLength = Exact Int | AtLeast Int

type ResponseBody
    = CompleteBody Bytes
    | TruncatedBody Bytes
    | RedirectBodyDiscarded

type Request                   -- body is present exactly once
request :
    { method : Method
    , url : Url
    , headers : List RequestHeader
    , body : Body
    , responseLimit : ResponseLimit
    , overLimit : OverLimit
    , discardManualRedirectBody : Bool
    }
    -> Result RequestError Request


type alias Response =
    { status : Int
    , statusText : String
    , headers : List ResponseHeader
    , setCookies : List String
    , url : Url
    , body : ResponseBody
    , decodedByteLength : DecodedLength
    }

send : OriginSet -> Deadline -> Request -> Task Error Response
```

`startDeadline` is a small kernel fact: monotonic-now plus bounded timeout. It
contains no timer or live resource. Every `send` computes remaining time from
that same deadline. Thus a redirect chain has one wall-clock budget including
application work between hops, rather than multiplying timeout by hop count.
An expired deadline fails before DNS/network dispatch.

### Exactly one body and method rules

`Request` stores one `Body`; empty is a constructor, not absence. No JSON,
multipart, text, and bytes option fields can coexist.

- `GET` and `HEAD` accept only `EmptyBody`.
- `CONNECT` and `TRACE` are rejected in v1.
- Other valid RFC token methods accept any `Body`.
- Node Fetch receives no `body` property for `EmptyBody`.
- `Utf8Body` size is the exact UTF-8 encoded byte length, not Elm character or
  UTF-16 code-unit length.
- `Utf8Body` and `BytesBody` are rejected above the fixed 8 MiB request-body
  hard limit before `fetch` dispatch. Empty is zero bytes.
- The package does not infer or overwrite `content-type`; WebFetch has no body.

The 8 MiB hard request limit is package mechanism policy and has no unbounded
escape hatch. A future upload-stream design is separate.

## 3. Cooperative `OriginSet` constitutional exception

`OriginSet` is opaque but **publicly mintable by any linked Elm code** through
`originSet`. It is ordinary pure data, not `Init.Task`, not a secret token, and
not a sandbox. This is a narrow exception to the program's “opaque capabilities
prevent expressing effects” rule: v1's set prevents accidental cross-origin use
and makes intended dependencies reviewable, but it does not provide unforgeable
authority. Documentation and naming must always say “cooperative origin set,”
never “network permission” or “SSRF protection.”

The kernel rechecks `allows` immediately before every dispatch as a consistency
backstop. Disallowed URLs fail `OriginNotAllowed` with **no DNS lookup and no
Fetch call**.

The package is explicitly not an SSRF, DNS-rebinding, or network-egress boundary:

- it does not resolve and classify IPs;
- it does not reject loopback, link-local, RFC1918, metadata, or Unix-local
  destinations merely because of their address;
- it does not pin DNS answers or ensure all connection attempts resolve to the
  same address class;
- it does not stop malicious linked Elm code from minting another set;
- it does not evaluate redirects automatically.

Existing harness WebFetch URL/egress policy remains the product-policy owner and
must run before minting each hop's singleton set. If that policy rejects a URL,
no set is minted and `send` is not called. If the existing policy allows a
loopback/private hostname, this package does not add a new negative rule. If
future hosting needs an IP egress firewall, it belongs at a resolver/network
boundary outside this package.

## 4. Exact URL and redaction contract

`url` and `resolve` use Node 24's WHATWG `URL`, behind pure kernel helpers, and
accept only absolute `http:` and `https:` results.

Canonicalization is exactly:

1. parse using WHATWG rules (`resolve` uses `new URL(reference, base)`);
2. reject non-empty username or password, including percent-encoded forms that
   WHATWG parses into user-info;
3. reject non-http(s) protocol;
4. lower-case scheme and hostname per WHATWG serialization;
5. use WHATWG IDNA ASCII/punycode hostname serialization;
6. preserve bracketed canonical IPv6 serialization;
7. elide default port 80 for HTTP and 443 for HTTPS; retain other ports;
8. use WHATWG path dot-segment resolution and percent-encoding serialization;
9. preserve query in the request URL but set fragment to empty before storing;
10. reject parse failure, missing hostname, forbidden port, and user-info rather
    than repairing them outside WHATWG behavior.

`Origin` is the serialized `URL.origin`; equality is exact canonical string
equality. Paths and queries do not affect the origin.

Errors and logs never include the original URL. A diagnostic URL, where useful,
is `scheme://host[:port]/<redacted>` only. Query, fragment, user-info, path,
request/response body, and header values are absent. `errorMessage` is bounded
to 512 characters after removing CR/LF; `errorCode` is an allowlisted stable
Node/Undici code, not an exception dump. Test failures may identify a fixture
case id, never secret wire values.

## 5. Distinct header contracts

### Request headers

`RequestHeader` validates an HTTP token name and a value without NUL/CR/LF.
Names are canonical lowercase. Values are passed to a fresh WHATWG `Headers`
using `append` in list order; WHATWG trimming/coalescing is therefore part of
the outbound contract. The package preserves input occurrences until that
boundary but does **not** promise raw duplicate header lines on the wire.

V1 rejects headers whose framing/authority must be owned by Fetch:
`connection`, `content-length`, `host`, `keep-alive`, `proxy-*`, `te`,
`trailer`, `transfer-encoding`, and `upgrade`. It also rejects `cookie`,
`set-cookie`, `authorization`, and `proxy-authorization`; secret-bearing
headers are deferred with credential injection. `accept` and `user-agent` are
allowed for WebFetch parity.

### Response headers

`ResponseHeader` is not constructible by callers. `headers` contains exactly the
entries yielded by Node 24 `Response.headers.entries()`, in that iterator's
order, with lowercase Fetch-normalized names and Fetch-normalized/coalesced
values. It does not claim raw-wire order or multiplicity. `setCookies` contains
`headers.getSetCookie()` values in the order Node exposes; `set-cookie` is
excluded from the general list to avoid two apparent authorities. Local-server
tests pin the exact supported Node 24 behavior.

## 6. Response bytes, compression, and total deadline

Node 24 global Fetch/Undici automatically decodes supported content encodings.
`ResponseLimit` applies to decoded bytes yielded by `Response.body`, because
those are retained and delivered to Elm. WebFetch requests at most 2,000,000
bytes, matching its current hard download cap; the package hard maximum is
8 MiB for future buffered consumers.

`Content-Length` commonly describes encoded wire bytes and is not trusted for
cap decisions. The reader always enforces the decoded count and retains no more
than the response limit. If a physical chunk crosses the cap, it copies only the
remaining permitted prefix, observes at least one excess decoded byte, and then
aborts/cancels without draining the remainder.

The caller chooses a typed policy in `Request`: `RejectOverLimit` returns
`ResponseTooLarge` and no response; `TruncateOverLimit` returns
`TruncatedBody prefix` with `decodedByteLength = AtLeast (limit + 1)`. A complete
body returns `CompleteBody bytes` and `Exact n`. Truncation is therefore never
presented as complete, and the package never claims an exact total it did not
read. WebFetch selects `TruncateOverLimit`, preserving its bounded partial-body
behavior; its legacy exact `byte_length` for an oversized response without a
trustworthy decoded length intentionally becomes an at-least fact/rendering.
Differential tests name this one compatibility difference. Other consumers use
`RejectOverLimit` by default.

A `Deadline` is total wall clock: DNS, connection, TLS, request send, headers,
body, redirects, and Elm work between redirect hops all consume it. There is no
idle-timeout reset. The kernel installs one timer for each `send` using only the
remaining shared budget and clears it on logical settlement.

HTTP status, including 4xx/5xx and manual 3xx, is a successful response fact.

## 7. One-shot Task state and truthful cancellation

The canonical operation state is:

```text
Prepared
  -- scheduler binding starts --> Dispatching(abort, timer, owner)
Dispatching
  -- response headers physical --> Reading(reader, chunks, kept, decodedSeen)
  -- fetch rejects/timeout -----> Settling(error)
Reading
  -- physical chunk in cap ----> Reading(updated)
  -- physical chunk crosses ---> Settling(ResponseTooLarge)
  -- physical EOF -------------> Settling(success)
  -- read error/timeout --------> Settling(error)
Any live state
  -- Elm Process.kill invokes binding kill --> Abandoned
Settling
  -- invoke scheduler callback once -------> CallbackQueued
CallbackQueued
  -- kill may occur, but cannot retract scheduler-owned result
Abandoned / CallbackQueued
  -- best-effort physical cleanup detached; references dropped --> Absent
```

`Scheduler.binding` returns its kill function **synchronously**, before Fetch can
settle. The kill function atomically marks the operation abandoned, clears its
timer, calls `AbortController.abort()`, calls `reader.cancel()` if present
without awaiting a possibly hanging promise, releases the reader lock where
possible, and drops retained chunks/references. It never invokes the Task
callback. All promise continuations first check state and become no-ops after
abandonment.

The truthful queued-result contract is:

- exactly one logical Task callback is invoked, or none if kill wins first;
- if physical Fetch/EOF/error has occurred but the callback has not yet been
  invoked, kill may still win and suppress it;
- once the callback is invoked and the result is queued in Elm's scheduler,
  `Process.kill` cannot retract that scheduler-owned result; ordinary Elm
  process scheduling determines whether downstream work runs;
- abort/cancel is cooperative and does not prove the server received no bytes;
- logical terminal/abandonment does not wait for physical Undici cleanup or an
  Elm callback acknowledgment.

Physical cleanup is bounded from the application's perspective: no cleanup
promise is awaited, no callback depends on cleanup acknowledgment, and a
1-second unref'ed diagnostic cleanup timer may drop remaining fixture bookkeeping
without holding process exit. The package guarantees released ownership and no
later logical event, not a timestamp at which the OS socket is physically gone.

## 8. Manual redirect adapter and WebFetch parity

`send` always uses `redirect = "manual"` and never follows. An ordinary Elm
`WebFetch.Transport` adapter owns this typed cold-path state:

```elm
type RedirectState
    = NextHop { url : Url, hopsUsed : Int, deadline : Deadline }
    | Finished Response
```

For each `NextHop`:

1. run existing WebFetch policy on the canonical URL;
2. if allowed, mint a singleton `OriginSet` for that URL's origin;
3. issue bodyless GET with the shared deadline,
   `discardManualRedirectBody = True`, and `TruncateOverLimit`;
4. the canonical one-shot machine, after receiving headers, returns
   `RedirectBodyDiscarded` without reading when status is 300–399 and a
   non-empty Fetch-normalized `location` exists;
5. the adapter resolves that location via `HttpClient.resolve`, increments hop
   count, and repeats; absent location is an ordinary 3xx whose body is read;
6. otherwise finish.

Parity is explicit: bodyless GET on every hop, relative `Location` resolution by
WHATWG URL, http(s)-only, at most 10 followed redirects, one total deadline, no
redirect response bytes charged against the final response content budget, and
typed errors for invalid/missing-usable targets or hop overflow. Current code
returns a 3xx response if `Location` is absent; the adapter preserves that.

The finite set is intentionally dynamic across the chain: there is no up-front
set of arbitrary redirect origins. Existing egress policy approves each target,
then a singleton cooperative set authorizes exactly that one dispatch. Cross-
origin sensitive-header rewriting is vacuous in v1 because secret/cookie/auth
request headers are unconstructible. `accept` and `user-agent` are reapplied on
each approved hop, matching current WebFetch behavior.

`discardManualRedirectBody` is a public, mechanical response-resource option,
not redirect-follow policy: it only says that a manual 3xx with a non-empty
normalized `location` returns `RedirectBodyDiscarded` after synchronously
starting best-effort body cancellation. It never resolves the location or issues
another request. This keeps one Task, one callback, and no long-lived handle.

## 9. One canonical machine, two assembled wrappers

There is one canonical JavaScript transaction function parameterized only by a
small operations record:

```text
nowMonotonic, setTimer, clearTimer, fetch, getReader, read,
cancelReader, releaseReader, abort, scheduleCallback
```

It contains all URL-origin recheck, deadline, body-read, cap, state, settlement,
and cancellation transitions. The production kernel wrapper supplies Node 24
Fetch and Elm scheduler constructors. The fixture wrapper supplies scripted
operations and observations. There is no hand-copied fake state machine.

Assembly follows the filesystem lesson:

- canonical source has mechanically marked fixture observation sites;
- production assembly removes sites and fixture imports entirely;
- fixture assembly replaces them with deterministic hooks;
- generated production and fixture kernels are distinct artifacts;
- an artifact gate rejects fixture names, hook markers, fake transport symbols,
  or observation calls in production;
- package modules never expose fixture operations.

## 10. Executable gates before integration

From the first implementation commit (after all six design documents):

1. **Real compiler artifacts:** package sources compile through the pinned
   Schelm compiler; app workers live under separate `fixture-apps/<case>/` with
   independent `elm.json`. Generated debug and `--optimize` JS are executed.
2. **No inert Elm tests:** property workers report executed case/seed counts;
   the runner fails on zero cases, missing reports, stale outputs, or compile-only
   success.
3. **Process cancellation:** real Elm workers `Process.spawn (send ...)` then
   `Process.kill` at generated races: before dispatch, delayed headers, each body
   chunk, physical EOF, before callback, and after callback queueing.
4. **Local servers:** bounded Node servers exercise delayed headers/body,
   resets, malformed lengths, gzip/br decoded expansion, duplicate headers,
   redirects, IPv4/IPv6/IDNA URLs, and connection close. No external network is
   required.
5. **Partition properties:** for generated bytes up to practical test bounds,
   every partition for small bodies and randomized partitions for larger bodies
   produce identical success bytes or identical first decoded cap crossing.
6. **Redirect properties:** generated relative/absolute chains, cycles, invalid
   targets, missing/multiple-normalized locations, dynamic origins, hop limits,
   and deadline consumption compare old WebFetch with the Elm adapter. Egress
   denial proves zero subsequent dispatch.
7. **Differential slice:** old `runWebFetch` and new adapter compare status,
   final canonical URL, normalized content type, binary/text decode, byte count,
   timeout class, redirect result, and cap/truncation decision against identical
   local fixtures. Differences require named assertions and migration notes.
8. **Scale/O(chunk):** 200 concurrent requests, each many chunks, instrument
   exactly one state transition and at most one bounded copy per new chunk; no
   scan over requests or prior chunks. At chunk 10,000, work remains O(chunk
   bytes), not O(total body/history). Retained bytes stay within summed caps plus
   one transient transport chunk per live request.
9. **Ownership/leaks:** after success, every failure phase, timeout, and kill,
   timer/controller/reader/chunk ownership is absent logically; handles and heap
   return to bounded baseline after physical cleanup opportunities.
10. **Provenance/isolation:** compiler commit/binary, package commit/archive,
    public seed, and exact Node 24 runtime are pinned with SHA-256 and offline
    verification. Binary integrity is not mislabeled reproducibility. Cold/warm
    builds use fresh per-invocation `ELM_HOME`; no ambient Elm/npm cache is read.
11. **Bounded time:** each property shard, worker, local server, delayed response,
    and cleanup test has a hard deadline and teardown. Servers bind loopback on
    ephemeral ports and are killed on every runner exit.

## 11. Error kinds

The narrowed mechanism algebra is:

```elm
type ErrorKind
    = InvalidRequest
    | OriginNotAllowed
    | DeadlineExceeded
    | ResponseTooLarge
    | NetworkFailure
    | CancelledByProcess       -- observable only in fixture diagnostics; killed Task emits no Err
    | UnsupportedRuntime
    | UnknownFailure
```

`Process.kill` normally produces no Task result, so `CancelledByProcess` is not
fabricated to the killed consumer. It exists only if a higher-level owner races
an explicit cancellation before killing or in fixture observations. HTTP status
is not an `ErrorKind`. UTF-8 is not a transport error because response transport
returns bytes.

The WebFetch adapter uses Node-compatible replacement decoding explicitly for
legacy parity (`Buffer.toString("utf8")` semantics tested against an Elm helper).
A strict UTF-8 helper, if exposed, returns its own decode error and is not mixed
into transport errors.

## 12. DRY end state and remaining deferrals

After WebFetch cutover:

- package kernel is its sole Fetch/body-cap mechanism;
- ordinary Elm WebFetch adapter is sole redirect policy;
- existing WebFetch Elm remains sole validation/presentation/HTML authority;
- old/new dual execution exists only in tests and is removed after evidence;
- `httpFetch` remains only for explicitly unmigrated consumers, listed by grep
  and migration issue, never as a hidden WebFetch fallback.

Authenticated `Rpc.Http`, multipart Media, session-index fetches, provider
streaming, SSE, and all LLM paths are deferred. Auth migration needs an opaque
host credential-injection design that keeps values out of Elm/errors/artifacts.
Streaming migration needs the compiler/effect-manager design described in A1.
Neither may be smuggled into v1 through optional fields or fixture-only APIs.

## 13. Decisions closed by revision A

- V1 is buffered one-shot Task only.
- `Init.Task` is removed; cooperative public `OriginSet` is named honestly.
- No SSRF/DNS-rebinding claim is made; harness egress policy remains owner.
- WebFetch is the selected first slice, with dynamic singleton origins per hop.
- Redirects are an ordinary Elm adapter machine, not hidden Fetch behavior.
- Request and response headers have different contracts.
- Body cardinality, methods, request limit, decoded response cap, compression,
  and shared total deadline are explicit.
- Task cancellation is immediate and truthful about queued scheduler results.
- URL canonicalization and error redaction are exact.
- Production and fixture wrappers assemble one canonical machine.
- Streaming/SSE/LLM are explicitly deferred.

Revision A closes redirect-body handling with typed
`RedirectBodyDiscarded` and preserves WebFetch truncation with typed
`TruncatedBody` plus an honest `AtLeast` decoded length. No source implementation
starts before the remaining independent review and design artifacts are
complete.
