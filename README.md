# sjalq/schelm-node-http-client

Bounded, one-response-at-a-time HTTP for Elm programs running on the pinned
Schelm Node runtime.

The package deliberately does **not** choose retries, redirects, credentials, or
streaming policy for you. Every request has a response byte limit and shares an
explicit deadline with any caller-owned chain.

## The model

```text
validate URL -> build bounded request -> send -> inspect and decode response
                                           \
                                            use Cancelable.send when the app
                                            must stop this operation later
```

`OriginSet` keeps one part of an application from accidentally using another
part's destinations. It is publicly mintable cooperative scoping, **not**
authorization, SSRF protection, or DNS-rebinding protection.

## A small GET

```elm
import Schelm.Node.HttpClient as Http
import Task exposing (Task)

fetchName : String -> Task String String
fetchName rawUrl =
    case ( Http.url rawUrl, Http.responseLimit 64, Http.timeout 5000 ) of
        ( Ok target, Ok limit, Ok duration ) ->
            let
                allowed =
                    Http.originSet (Http.origin target) []
            in
            Http.startDeadline duration
                |> Task.mapError never
                |> Task.andThen
                    (\deadline ->
                        Http.send allowed deadline (Http.get target limit)
                    )
                |> Task.mapError explainHttpError
                |> Task.andThen
                    (Http.bodyJson (Json.Decode.field "name" Json.Decode.string)
                        >> resultToTask
                    )

        _ ->
            Task.fail "Invalid URL, limit, or timeout"
```

`bodyText` is strict UTF-8. `bodyBytes`, `bodyText`, and `bodyJson` reject
truncated or deliberately discarded bodies instead of pretending they are
complete.

## Sending JSON

```elm
case Http.jsonBody (Json.Encode.object [ ( "name", Json.Encode.string "Elm" ) ]) of
    Err requestError ->
        -- The encoded body exceeded the package hard limit.
        ...

    Ok body ->
        Http.request
            { method = Http.postMethod
            , url = target
            , headers = [ Http.jsonRequestHeader ]
            , body = body
            , responseLimit = limit
            , overLimit = Http.RejectOverLimit
            , discardRedirectBody = False
            }
```

The content-type header stays explicit. Encoding JSON does not silently change
request headers.

## `Task` or cancellable `Cmd`?

Use `Http.send` for normal task composition: sequential work, startup tasks, or
jobs where the owner does not need a later stop command.

Use `Schelm.Node.HttpClient.Cancelable.send` when the application must retain an
operation and cancel it later, for example on user interrupt or owner shutdown:

```elm
Cancelable.send
    { onStarted = RequestStarted
    , onFinished = RequestFinished
    }
    allowed
    deadline
    request

-- later
Cancelable.cancel operation
```

`onStarted` always arrives before `onFinished`. If cancellation wins, no
`onFinished` message is delivered. Logical ownership ends immediately; physical
network cleanup may finish later.

## Redirect recipe

The package returns redirects; it never follows them automatically. A caller
can keep redirect policy ordinary and visible Elm:

```elm
followOne allowed limit deadline response =
    case locationHeader response of
        Nothing ->
            Task.fail MissingLocation

        Just reference ->
            case Http.resolve (Http.responseUrl response) reference of
                Err _ ->
                    Task.fail InvalidLocation

                Ok next ->
                    if Http.allows allowed next then
                        -- Reuse the one total deadline. Add an application hop
                        -- limit around this recipe before making it recursive.
                        Http.send allowed deadline (Http.get next limit)

                    else
                        Task.fail RedirectOriginNotAllowed
```

For an intentionally allowed cross-origin redirect, construct a new finite
`OriginSet` from validated origins before dispatch. Do not derive unrestricted
network authority from a `Location` header.

## Recovering from errors

Match `Http.errorKind`; do not parse `errorMessage` or platform codes.

| Kind | Sensible next decision |
| --- | --- |
| `InvalidRequestError`, `OriginNotAllowed` | Fix configuration; the same value will fail again. |
| `DeadlineExceeded` | Retry only if application policy permits, with a fresh deadline. |
| `ResponseTooLarge` | Request less, raise the validated limit, or deliberately select truncation. |
| `NetworkFailure` | Retry policy belongs to the application. |
| `UnsupportedRuntime` | Fix the deployment. |
| `UnknownFailure` | Report the bounded diagnostic; do not classify its text. |

Constructor errors (`UrlError`, `MethodError`, `RequestHeaderError`,
`RequestError`, `LimitError`, `TimeoutError`) identify the value to fix before
any network work begins. `BodyError` distinguishes incomplete bodies, invalid
UTF-8, and invalid JSON.

## Deliberate limits

V1 has no streaming, SSE, credential store, multipart builder, retry helper, or
automatic redirect policy. It targets pinned Node 24.4.1 on the private Schelm
Elm 0.19.2 toolchain.

Executable debug and optimized fixtures cover the common GET, JSON, strict UTF-8,
redirect recipe, deadline, byte-limit, and cancellable-command paths. The full
transport and manager design is in `docs/design/05-design-revision-b.md`,
`06-property-test-plan.md`, `07-cancellable-manager-addendum.md`, and
`08-ergonomics-audit.md`.
