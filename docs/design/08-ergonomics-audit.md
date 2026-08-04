# 08 — Evan-level ergonomics audit

Status: accepted implementation brief for the final v1 ergonomics pass.

This audit does not reopen the reviewed transport, origin, deadline, byte-limit,
or cancellation invariants. It asks whether an Elm user can do the ordinary job
without first learning the Node implementation.

## 1. User mental model

The smallest useful model is:

1. Validate a URL and choose which origins this part of the program may contact.
2. Build one bounded request.
3. Send it as a `Task`, or use `Cancelable.send` when the application must retain
   an operation value and stop the work later.
4. Inspect the response status and decode its complete body.
5. Treat redirects as responses; following one is an explicit Elm loop that
   resolves and rechecks every destination.

Node, Fetch, Undici, `AbortController`, scheduler bindings, manager mailboxes,
and operation numbers are implementation details. They belong in design and
verification documents, not in the first user example or routine error text.

## 2. Invalid states and honest boundaries

The existing opaque values are the right core and remain authoritative:

- `Url` is valid HTTP(S), has a host, and contains no user-info.
- `OriginSet` is non-empty because its constructor requires a first `Origin`.
- `Method`, `RequestHeader`, `ResponseLimit`, and `Timeout` are validated once.
- `Request` has exactly one body and one over-limit policy.
- `ResponseBody` distinguishes complete, truncated, and deliberately discarded
  bodies; decoding helpers must not erase those states.
- `Deadline` is total across a caller-owned chain, including redirects.
- a cancellable operation is minted only by the effect manager, and settled
  manager ownership is absence.

Security wording remains explicit: `OriginSet` is publicly mintable cooperative
scoping. It prevents accidental origin mixing; it is not authorization, SSRF
protection, or DNS-rebinding protection. Redirect recipes must call `resolve`
and rebuild/recheck each request rather than introducing automatic redirects.

New convenience helpers may only construct or inspect these core values. They
must not add a second request representation, hidden redirect authority, retry
policy, implicit truncation, lossy UTF-8 decoding, or ambient defaults for
limits and timeouts.

## 3. Tiny core plus recipes

### Keep as the orthogonal core

`url`, `resolve`, `originSet`, `method`, `requestHeader`, body constructors,
`responseLimit`, `timeout`, `startDeadline`, `request`, response accessors,
`send`, and `Cancelable.send/cancel` remain the complete mechanism.

### Add predictable 80% helpers

The public facade should add only helpers definable from that core:

- named common methods (`getMethod`, `postMethod`) so examples do not validate
  string constants;
- `get` for the ordinary empty-body GET request;
- `withHeader` and `withBody` for readable request assembly while preserving
  request validation;
- `jsonBody` and `jsonRequestHeader` when `elm/json` is admitted as a direct
  dependency;
- strict complete-body helpers: `bodyBytes`, `bodyText`, and `bodyJson`.

The body helpers return a small typed `BodyError`: truncated and discarded
bodies stay distinguishable; invalid UTF-8 and invalid JSON are recoverable
without parsing strings. JSON decoding uses the caller's `Decoder`, so schema
policy stays in the application.

A short redirect recipe belongs in documentation and a compiled fixture. It is
not a package-level `followRedirects` function: redirect status selection, hop
limit, method rewriting, cross-origin policy, and deadline reuse are application
policy. The recipe must visibly resolve `Location`, extend or reject the
cooperative origin set, reuse one deadline, and issue the next request.

## 4. Task versus cancellable Cmd

The broad primitive stays:

```elm
send : OriginSet -> Deadline -> Request -> Task Error Response
```

Use it when normal Elm task composition owns the lifetime: startup work,
sequential chains, `ConcurrentTask` adapters, and bounded jobs where dropping a
result is sufficient.

Use `Schelm.Node.HttpClient.Cancelable.send` only when the application needs a
first-class operation that can be cancelled later (user interrupt, owner
shutdown, superseded request). Its two callbacks make the real race visible:
`onStarted` supplies the operation before `onFinished` can arrive; if cancel
wins, no finished message is delivered. Renaming the module or operation to
pretend physical network cleanup is instantaneous would weaken honesty, so the
existing names remain.

## 5. Recovery-oriented errors

Constructor errors remain narrow and local. Runtime callers recover by matching
`errorKind`:

- `InvalidRequestError`, `OriginNotAllowed`: fix configuration; do not retry the
  same value.
- `DeadlineExceeded`: choose a new deadline only if application policy permits.
- `ResponseTooLarge`: raise the validated limit, request a smaller resource, or
  deliberately choose truncation.
- `NetworkFailure`: application policy may retry with a fresh deadline.
- `UnsupportedRuntime`: fix the deployment.
- `UnknownFailure`: report the stable diagnostic fields; do not parse the
  message.

`errorMessage` remains a bounded human diagnostic and `errorCode` an optional
platform fact, never a control-flow protocol. README examples must lead with
`errorKind`, not host codes.

## 6. Executable claims

Every new helper is exercised by real debug and optimized Elm fixture builds.
Tests must cover:

- common method and GET construction without string validation;
- JSON body/header construction and strict JSON decoding;
- complete UTF-8 success, malformed UTF-8 failure, truncated rejection, and
  discarded redirect-body rejection;
- request modifiers preserving the existing body/method and hard-size checks;
- a compiled explicit redirect recipe;
- unchanged manager ordering/cancellation and production artifact gates.

The final package commit must pass assembly, toolchain, generated debug/optimized
workers, Node model/property tests, artifact/archive checks, and bounded
performance gates. Harness provenance is regenerated from that exact commit;
then focused integration tests and the full bounded harness gates run against
that pin. No deployment is authorized by this stream.

## Decision

Proceed with the helpers and documentation above. Keep the kernel and effect
manager unchanged unless an executable helper test exposes a real boundary bug.
The successful outcome is a shorter first useful program, not a larger transport.
