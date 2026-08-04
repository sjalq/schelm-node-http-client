# 02 — Adversarial review A

Verdict: **reject implementation of `01-design.md`**.

The first design has the right instincts—one body, bounded bytes, manual
redirects, cooperative authority, real generated artifacts—but it designs two
packages at once. Its streaming half is not justified by the current compiler
or runtime. Several boundaries are described more strongly than they can be
implemented.

## Blocking findings

### A1. The streaming API is fictional without an effect-manager design

`stream : ... -> Cmd msg`, `continue`, and `cancel` imply a long-lived command
resource, routing of later commands to it, application callback ownership, and
cleanup across application/process termination. That is an effect manager, not
a slightly larger kernel `Task`. The document does not specify compiler support,
manager initialization, command mapping, subscription behavior, or runtime
lifecycle. A JavaScript global registry would hide the missing design rather
than make it safe.

The proposed “scheduler callback acknowledgment” also depends on undocumented
runtime details and conflates callback invocation, process scheduling, message
delivery, and application handling. No implementation should begin from that
contract. V1 must be one-shot buffered `Task` transport only. Streaming, SSE,
and LLM migration require a separate compiler/effect-manager design.

### A2. `Init.Task` is not available in Elm

The API copies Gren syntax that does not exist in the inspected Elm fork or
package dependencies. An open question cannot remain in the proposed public
signature. Either implement and prove a trusted bootstrap facility first or
name the weaker thing honestly. For v1, prefer an ordinary, publicly mintable,
opaque `OriginSet` and record a narrow constitutional exception: this is
cooperative dependency scoping, not unforgeable authority.

### A3. Host scoping is overstated as network security

An origin string check does not stop SSRF, DNS rebinding, redirects to a private
address, resolver changes, alternate IP spellings, or a compromised linked Elm
module minting another set. The package is not an egress firewall. Existing
harness egress policy must remain the sole product-policy owner. The design must
say what the package deliberately does *not* reject, including loopback/private
addresses and DNS changes unless the caller's policy rejects them.

### A4. Redirect ownership and permission evolution are unresolved

The document says the kernel always returns manual 3xx and Elm owns redirects,
but its properties speak as if the package preserves host scope across redirect
graphs. A finite initial origin set cannot predict WebFetch's arbitrary redirect
targets. The design must choose:

- a typed redirect machine in this package, including hop and deadline policy;
  or
- one-shot package requests plus an ordinary Elm WebFetch adapter.

For the latter, specify that each hop is parsed and policy-checked by the adapter,
then dispatched with a newly minted singleton origin set. State exact parity:
relative resolution, 10-hop cap, shared total deadline, http(s)-only targets,
GET behavior, and no redirect-body budget consumption.

### A5. One `Header` type cannot state both contracts

Request headers are caller-authored ordered pairs with validation. Response
headers are Fetch-normalized facts. Reusing one opaque type suggests symmetry
that does not exist. Node Fetch can combine duplicates and normalize names;
`set-cookie` has special access. Split `RequestHeader` and `ResponseHeader` and
state exact ordering, case, whitespace, and multiplicity guarantees.

### A6. Body and resource limits remain underspecified

The design correctly has one `Body`, but does not close these questions:

- which methods reject bodies;
- whether request bodies have a byte cap;
- whether UTF-8 size is code units or encoded bytes;
- whether timeout is headers-only, idle, or total wall clock;
- whether response cap is compressed or decoded bytes;
- whether `Content-Length` can cause early failure;
- whether a cap crossing returns partial bytes.

These are observable compatibility contracts, not implementation details.

### A7. Cancellation is described for a stream, not for the actual Task

A one-shot Elm `Task` is cancellable by putting it in an Elm process and calling
`Process.kill`. Kernel `Scheduler.binding` must return a kill function
immediately. The document must specify races where Fetch has physically settled
or the task callback has already queued a result. It may promise one logical
terminal and no callback *after kill wins*; it may not promise that killing can
retract a callback already handed to the scheduler. Physical `reader.cancel()`
or Undici cleanup may outlive logical settlement and must not wait on an Elm
callback acknowledgment.

### A8. URL behavior is not exact enough

“Normalized origin” is insufficient. The contract must pin WHATWG `URL`
canonicalization: ASCII/punycode hostname, lowercase scheme/host, default-port
elision, IPv6 brackets, dot-segment path normalization, user-info rejection,
fragment stripping, and treatment of credentials or encoded delimiters. Error
messages must never echo query, fragment, user-info, request headers, or body.

### A9. The fake transport risks becoming a second implementation

A fixture-only fake and separate production algorithm can drift. One canonical
transaction/state machine must accept a narrow transport interface. Production
and fixture wrappers supply real Fetch versus scripted operations. Fixture
hooks must be physically absent from the production artifact, while state
transitions remain the same source.

### A10. The harness cutover is not decisive

“Preferably WebFetch” is not a selected slice. The revision must name a cutover
that deletes an old authority for that slice. If WebFetch is selected, its
redirect loop moves to Elm and `web-fetch.js` must no longer import or call
`httpFetch`; differential dual execution is test-only and temporary. It is
acceptable that authenticated/multipart `Rpc.Http` remains temporarily, but the
document must not claim that the whole old HTTP kernel has been removed.

### A11. Test evidence needs stronger runtime and scale requirements

The proposed tests do not yet require:

- real Schelm compiler app fixtures, separate from package sources;
- debug and optimized execution;
- `Process.kill` races against delayed headers/body/end/callback;
- every partition of a byte body into chunks;
- decoded-byte cap tests under compression;
- dynamic redirect origin evolution;
- 200 concurrent buffered requests and O(new chunk) instrumentation;
- fully pinned offline compiler/package/Node provenance;
- bounded test processes and local servers;
- proof that Elm property suites execute rather than merely compile.

These must be blocking gates, applying the filesystem package's post-implementation
lessons from the first implementation commit.

## Non-blocking observations

1. Bytes as the transport result are preferable to implicit UTF-8 decoding.
2. HTTP status should remain a successful response fact.
3. Manual redirects are the correct mechanism boundary for WebFetch.
4. Provider schemas, SSE parsing, retries, HTML reduction, and credential policy
   should remain outside the package.
5. Node 24 global Fetch is a defensible v1 boundary if its exact runtime artifact
   and Fetch-visible header behavior are pinned and tested.

## Required revision

Before implementation, revision A must:

1. delete every streaming/`Cmd` API from v1 and explicitly defer it;
2. replace fictional `Init.Task` with an honest cooperative `OriginSet` (or land
   a real trusted bootstrap implementation first);
3. define URL, method/body/header/limit/deadline/cancellation contracts exactly;
4. select one WebFetch buffered cutover with a typed ordinary-Elm redirect loop;
5. define one canonical machine parameterized by production/fake transport;
6. require executable debug/optimize, cancellation, differential, partition,
   redirect, compression-cap, 200-request, provenance, and bounded-time tests.

Until that revision survives the next independent review, source implementation
remains rejected.
