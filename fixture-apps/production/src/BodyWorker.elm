port module BodyWorker exposing (main)

import Bytes.Encode as BE
import Json.Encode as E
import Platform
import Schelm.Node.HttpClient as Http
import Task


port report : E.Value -> Cmd msg


type Msg
    = Done (Result Http.Error Http.Response)


type alias Flags =
    { url : String, method : String, body : String }


main : Program Flags () Msg
main =
    Platform.worker { init = init, update = update, subscriptions = always Sub.none }


init flags =
    case ( Http.url flags.url, Http.method flags.method ) of
        ( Ok target, Ok method_ ) ->
            case ( Http.responseLimit 1024, Http.timeout 2000 ) of
                ( Ok limit, Ok duration ) ->
                    case body flags.body of
                        Ok body_ ->
                            case Http.request { method = method_, url = target, headers = [], body = body_, responseLimit = limit, overLimit = Http.RejectOverLimit, discardRedirectBody = False } of
                                Ok req ->
                                    ( (), Http.startDeadline duration |> Task.mapError never |> Task.andThen (\deadline -> Http.send (Http.originSet (Http.origin target) []) deadline req) |> Task.attempt Done )

                                Err Http.MethodDoesNotAllowBody ->
                                    rejected "method-body"

                                Err _ ->
                                    rejected "request"

                        Err _ ->
                            rejected "body"

                _ ->
                    rejected "flags"

        _ ->
            rejected "flags"


body kind =
    case kind of
        "empty" ->
            Ok Http.emptyBody

        "utf8-empty" ->
            Http.utf8Body ""

        "binary-empty" ->
            Http.bytesBody (BE.encode (BE.sequence []))

        _ ->
            Http.utf8Body kind


rejected reason =
    ( (), report (E.object [ ( "kind", E.string "rejected" ), ( "reason", E.string reason ) ]) )


update (Done result) model =
    ( model
    , report <|
        case result of
            Ok response ->
                E.object [ ( "kind", E.string "success" ), ( "status", E.int (Http.status response) ) ]

            Err error ->
                E.object [ ( "kind", E.string "error" ), ( "message", E.string (Http.errorMessage error) ) ]
    )
