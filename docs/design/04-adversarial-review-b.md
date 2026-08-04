# 04 — Adversarial review B

Verdict: **implementation remains blocked**. Revision A is materially safer, but
its final observable and runtime contracts are not yet total.

## Blocking findings

### B1. Redirect behavior is still described as “3xx”

WebFetch must follow exactly `301`, `302`, `303`, `307`, and `308`; it must not
follow `300`, `304`, `305`, `306`, or arbitrary `3xx`. The adapter needs a total
result algebra distinguishing final response, invalid/missing location behavior,
hop exhaustion, policy denial, deadline, transport failure, and malformed URL.
It must define whether the initial request counts as a hop and remove “exactly
one Location” language that contradicts Fetch-normalized headers.

### B2. `Response` is still a transparent alias

A record containing an independent `ResponseBody` and `DecodedLength` permits
nonsensical combinations such as complete bytes plus `AtLeast`, truncated bytes
plus `Exact`, and discarded redirect plus a byte count. `Response` must be opaque
and expose a single body sum whose constructors carry only valid metadata.

### B3. The heap-cap claim is too strong

Undici's decompressor may allocate a decoded chunk before package code sees it.
“Cap plus one transport chunk” is not an enforceable byte bound unless Node's
maximum decoded chunk/transient behavior is measured and pinned. The package can
guarantee retained package-owned bytes, not all transient Undici/V8 allocation.
Either adopt a lower-level transport with a proven bound or publish an honest,
measured overhead envelope and fail its runtime gate when the pinned Node build
exceeds it. Do not call this a strict process heap cap.

### B4. Deadline and cancellation settlement order is incomplete

At deadline, logical terminal state must be claimed deterministically before
calling abort, because abort rejection can race the timer and change the error.
Remaining milliseconds need exact ceiling/clamp behavior; zero must reject
without setting a timer or dispatching. The same claim-before-verb rule applies
to cap failure and process kill.

### B5. Resource cleanup lacks a complete ownership state

The design must enumerate cleanup before response, response with no body,
response before reader acquisition, owned reader with no pending read, pending
read, EOF/released reader, and callback queued. Every cleanup verb can throw or
return a rejecting promise and must be exception-contained and idempotent.
Production must not retain diagnostic entries or cleanup timers after logical
terminal state.

### B6. Scheduler delivery has a reentrancy hole

The machine must set `CallbackQueued` before invoking the scheduler callback.
Every synchronous boundary—URL, Headers, AbortController, timer, fetch call,
body/getReader/read/cancel/release, response field/header enumeration, byte copy,
and callback invocation—must be wrapped so a throw cannot create a second
terminal or escape the Task.

`CancelledByProcess` is not a public error: a killed Task does not resolve. It
must be removed rather than explained as fixture-only in a public algebra.

### B7. Node Fetch semantics are not fully pinned

Final design must specify HEAD/204/304 body handling, automatic
`accept-encoding`, visible encoded response headers after decoded body delivery,
manual-redirect `response.url`, duplicate/coalesced `Location`, method
normalization, and request header normalization. Tests must use a raw Node HTTP
server as the header oracle, not merely compare Fetch to itself.

### B8. Error and URL exposure remain leaky

“Sanitize raw exception text” is not sufficient; messages must be constructed
from closed error kinds and allowlisted codes, with no raw exception message at
all. `toString : Url -> String` deliberately exposes query data; the API must
name/document that exposure and provide a redacted diagnostic function. Request
bytes must be copied before dispatch so caller-visible backing buffers cannot be
mutated during Fetch.

### B9. Canonical-machine injection is underspecified

The injected surface must explicitly include Fetch, reader acquisition/read,
timers, abort, and delivery. Production and fixture wrappers must assemble from
one canonical source while proving fixture hooks absent from production. A fake
that mocks only the outer promise cannot exercise physical/ack/kill races.

### B10. The harness integration boundary is wrong or incomplete

Today WebFetch is executed by `tools-impl.js`, which imports `web-fetch.js`,
which calls `httpFetch`. Saying an Elm adapter owns the new path does not explain
how the running `ServerMain` worker executes the Task or routes completion into
the existing tool wave. Final design must name the new Elm `Effect`/message and
where `StateMachine.applyEffects` executes the Task. At cutover, the host
WebFetch branch must be poisoned so accidental fallback fails tests, and the old
WebFetch HTTP authority must be deleted. Differential comparison must use a
frozen hash-verified legacy implementation, not a mutable copy that can drift
with the replacement.

### B11. Intentional compatibility differences are not closed

A migration cannot ship with “named differences as discovered.” The final design
must enumerate the only allowed WebFetch differences. Any other differential
mismatch blocks cutover.

## Required final artifacts

`05-design-revision-b.md` must close every item above. `06-property-test-plan.md`
must make the reference machine executable and cover dispatch/physical
settlement/delivery acknowledgment/process kill, compression expansion, raw
header oracles, 200-request instrumentation, real compiler debug/optimize
workers, supervised timeouts, and offline provenance. No source is authorized
until both documents are committed and pushed.
