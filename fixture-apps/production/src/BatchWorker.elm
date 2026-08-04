port module BatchWorker exposing (main)

import Json.Encode as E
import Platform
import Schelm.Node.HttpClient as Http
import Task


port report : E.Value -> Cmd msg


type Msg
    = Done (Result Http.Error Http.Response)


type alias Flags =
    { url : String, count : Int, limit : Int }


type alias Model =
    { remaining : Int, failures : Int }


main : Program Flags Model Msg
main =
    Platform.worker { init = init, update = update, subscriptions = always Sub.none }


init flags =
    case ( Http.url flags.url, Http.method "GET" ) of
        ( Ok target, Ok get ) ->
            case ( Http.responseLimit flags.limit, Http.timeout 30000 ) of
                ( Ok limit, Ok duration ) ->
                    case Http.request { method = get, url = target, headers = [], body = Http.emptyBody, responseLimit = limit, overLimit = Http.TruncateOverLimit, discardRedirectBody = False } of
                        Ok req ->
                            let
                                task =
                                    Http.startDeadline duration
                                        |> Task.mapError never
                                        |> Task.andThen (\deadline -> Http.send (Http.originSet (Http.origin target) []) deadline req)
                                        |> Task.attempt Done
                            in
                            ( { remaining = flags.count, failures = 0 }, Cmd.batch (List.repeat flags.count task) )

                        Err _ ->
                            invalid

                _ ->
                    invalid

        _ ->
            invalid


invalid =
    ( { remaining = 0, failures = 1 }, report (E.object [ ( "kind", E.string "invalid" ) ]) )


update (Done result) model =
    let
        failed =
            case result of
                Ok response ->
                    case Http.responseBody response of
                        Http.Truncated _ ->
                            0

                        _ ->
                            1

                Err _ ->
                    1

        failures =
            model.failures + failed

        remaining =
            model.remaining - 1

        next =
            { remaining = remaining, failures = failures }
    in
    if remaining == 0 then
        ( next, report (E.object [ ( "kind", E.string "batch" ), ( "failures", E.int failures ) ]) )

    else
        ( next, Cmd.none )
