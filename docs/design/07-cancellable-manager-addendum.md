# 07 — Cancellable command-manager addendum

Status: design amendment for v1 integration. The existing buffered
`send : OriginSet -> Deadline -> Request -> Task Error Response` remains the
broad primitive. This adds an ergonomic cancellable `Cmd` surface owned by an
authorized-package effect manager; streaming remains deferred.

## 1. Feasibility and legality

The private compiler fork authorizes `sjalq` packages as kernel/effect packages.
Elm 0.19.2 already compiles package effect modules (`Task`, `Random`, `Http`): an
effect module supplies `command = MyCmd`, `cmdMap`, `init`, `onEffects`, and
`onSelfMsg`. Applications still cannot declare effects or import `Elm.Kernel.*`.
Therefore a specialized manager in this package is legal without changing
elm/core or adding an application port/global registry.

The harness blocker is real: core `Task.attempt` routes completion but hides the
process id, while `Process.spawn` returns the id but discards the result. The
manager solves this by spawning a Task that converts terminal result into a
manager self-message. It owns the process id in manager State and forwards
application messages through `Platform.sendToApp`.

## 2. Public surface

```elm
type Operation                         -- opaque manager-minted scalar

type alias Callbacks msg =
    { onStarted : Operation -> msg
    , onFinished : Operation -> Result Error Response -> msg
    }

sendCancelable :
    Callbacks msg
    -> OriginSet
    -> Deadline
    -> Request
    -> Cmd msg

cancel : Operation -> Cmd msg
```

`Operation` is manager-minted. Callers cannot choose operation ids. It is
comparable only through package operations if ever needed; representation stays
private. `cancel` is idempotent.

## 3. State and ordering

```elm
type alias State =
    { nextOperation : Int
    , active : Dict Int Active
    }

type alias Active =
    { pid : Process.Id
    , onFinished : Result Error Response -> appMsg
    }
```

Start handling is serialized by the manager mailbox:

1. allocate the next inactive scalar operation number and advance the counter;
2. construct opaque `Operation operationId`;
3. spawn `send ... |> Task.onError ... |> Task.andThen (sendToSelf Completed)`;
4. store `{ pid, onFinished }` in `active`;
5. only then send `onStarted operation` to the app;
6. process the next manager mailbox item.

Even a synchronously resolving Task cannot overtake `onStarted`: completion is a
self-message queued after spawn; `onEffects` sends `onStarted` before returning
to the manager loop, and `onSelfMsg` handles completion later.

## 4. Terminal races

- **Completion first:** `Completed operationId result` matches active,
  removes ownership first, then sends exactly one `onFinished result`.
- **Cancel first:** `Cancel operation` matches active, removes ownership first,
  then `Process.kill pid`; no app result is sent.
- **Simultaneous:** manager mailbox serialization picks one of the two rules.
- **Duplicate completion:** first removes active; all later messages no-op.
- **Duplicate cancel:** first removes active; later commands no-op.
- **Stale operation:** completion/cancel for an absent operation no-ops. The
  counter does not reuse an active scalar; wrap probes occupied keys before minting.
- **Unknown operation:** no-op.

At most one result follows one start; cancel-first yields none. Settled ownership
is absent, not a status flag.

## 5. `Cmd.map` laws

`cmdMap f` maps both callbacks and preserves opaque operation/request data:

```elm
Start callbacks ...
  -> Start
       { onStarted = callbacks.onStarted >> f
       , onFinished = callbacks.onFinished >> f
       }
       ...
Cancel operation
  -> Cancel operation
```

Identity and composition hold structurally. Manager self-messages contain the
already mapped app callback captured in `Active`; they never cast or reconstruct
application messages.

## 6. Physical cleanup and complexity

Cancel removes logical ownership before `Process.kill`. Killing invokes the
underlying `Scheduler.binding` kill function, which claims abandonment and calls
AbortController/reader cleanup as specified by revision B. Physical Undici
cleanup may lag; no completion is delivered after cancel wins.

State retains one scalar counter plus the active `Dict`; memory is O(active), not
O(all prior operations). Lookup/insert/remove is `Dict` O(log active operations).
Counter wrap uses occupied-key probes so it cannot mint an active capability;
this astronomically cold collision path is O(k log active), not falsely called O(1). `onEffects`
folds only the current command batch with cons/reverse or tail recursion; it
never scans `active` per command and never appends to an accumulator. Completion
and cancel touch one slot.

## 7. Tests and artifacts

Blocking package tests:

- pure generated manager traces for start/completion/cancel/double/stale races;
- debug and optimized real compiler effect-manager apps;
- synchronous completion proves started-before-finished;
- cancel-before-completion produces no finish;
- double completion/cancel and stale operation isolation;
- 200 concurrent operations with exact start/finish counts and empty final State;
- real hanging HTTP cancellation closes logical ownership and emits no result;
- `Cmd.map` identity/composition observations;
- production artifact contains manager but no fixture hooks/registries;
- package archive/provenance updated to the final commit.

Fixture observation hooks remain app-only; production manager has none. This
manager is request cancellation only, not response streaming/SSE/backpressure.
