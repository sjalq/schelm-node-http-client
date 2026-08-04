port module HttpWorker exposing (main)

import Bytes
import Bytes.Decode as BD
import Json.Encode as E
import Platform
import Schelm.Node.HttpClient as Http
import Task


port report : E.Value -> Cmd msg


type Msg
    = Done (Result Http.Error Http.Response)


type alias Flags =
    { url : String, limit : Int, timeoutMs : Int, truncate : Bool, discardRedirectBody : Bool }


main : Program Flags () Msg
main =
    Platform.worker { init = init, update = update, subscriptions = always Sub.none }


init flags =
    case ( Http.url flags.url, Http.method "GET" ) of
        ( Ok target, Ok get ) ->
            case ( Http.responseLimit flags.limit, Http.timeout flags.timeoutMs ) of
                ( Ok limit, Ok duration ) ->
                    case
                        Http.request
                            { method = get
                            , url = target
                            , headers = []
                            , body = Http.emptyBody
                            , responseLimit = limit
                            , overLimit =
                                if flags.truncate then
                                    Http.TruncateOverLimit

                                else
                                    Http.RejectOverLimit
                            , discardRedirectBody = flags.discardRedirectBody
                            }
                    of
                        Ok req ->
                            ( (), Http.startDeadline duration |> Task.mapError never |> Task.andThen (\deadline -> Http.send (Http.originSet (Http.origin target) []) deadline req) |> Task.attempt Done )

                        Err _ ->
                            invalid

                _ ->
                    invalid

        _ ->
            invalid


invalid =
    ( (), report (E.object [ ( "kind", E.string "invalid" ) ]) )


update (Done result) model =
    ( model
    , report <|
        case result of
            Err error ->
                E.object [ ( "kind", E.string "error" ), ( "error", E.string (errorName (Http.errorKind error)) ) ]

            Ok response ->
                let
                    body =
                        Http.responseBody response
                in
                E.object
                    [ ( "kind", E.string "success" )
                    , ( "status", E.int (Http.status response) )
                    , ( "bodyKind", E.string (bodyName body) )
                    , ( "bytes", E.list E.int (bytes body) )
                    ]
    )


bodyName body =
    case body of
        Http.Complete _ ->
            "complete"

        Http.Truncated _ ->
            "truncated"

        Http.DiscardedRedirectBody ->
            "discarded-redirect"


bytes body =
    case body of
        Http.Complete value ->
            decode value

        Http.Truncated value ->
            decode value.prefix

        Http.DiscardedRedirectBody ->
            []


decode value =
    BD.decode (BD.loop ( Bytes.width value, [] ) decodeStep) value |> Maybe.withDefault []


decodeStep ( left, acc ) =
    if left <= 0 then
        BD.succeed (BD.Done (List.reverse acc))

    else
        BD.unsignedInt8 |> BD.map (\n -> BD.Loop ( left - 1, n :: acc ))


errorName kind =
    case kind of
        Http.InvalidRequestError ->
            "invalid-request"

        Http.OriginNotAllowed ->
            "origin-not-allowed"

        Http.DeadlineExceeded ->
            "deadline-exceeded"

        Http.ResponseTooLarge ->
            "response-too-large"

        Http.NetworkFailure ->
            "network-failure"

        Http.UnsupportedRuntime ->
            "unsupported-runtime"

        Http.UnknownFailure ->
            "unknown-failure"
