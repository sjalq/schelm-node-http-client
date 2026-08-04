port module ErgonomicsWorker exposing (main)

import Json.Decode as Decode
import Json.Encode as Encode
import Platform
import Schelm.Node.HttpClient as Http
import Task exposing (Task)


port report : Encode.Value -> Cmd msg


type Msg
    = Finished (Result String String)


type alias Flags =
    { url : String, mode : String }


main : Program Flags () Msg
main =
    Platform.worker
        { init = init
        , update = update
        , subscriptions = always Sub.none
        }


init : Flags -> ( (), Cmd Msg )
init flags =
    case ( Http.url flags.url, Http.responseLimit 32, Http.timeout 2000 ) of
        ( Ok target, Ok limit, Ok duration ) ->
            let
                origins =
                    Http.originSet (Http.origin target) []

                base =
                    Http.get target limit
                        |> Http.withHeader Http.jsonRequestHeader

                task =
                    Http.startDeadline duration
                        |> Task.mapError never
                        |> Task.andThen
                            (\deadline ->
                                case flags.mode of
                                    "json" ->
                                        Http.send origins deadline base
                                            |> Task.mapError httpError
                                            |> Task.andThen decodeName

                                    "redirect" ->
                                        followOne origins deadline base

                                    "post-json" ->
                                        case Http.jsonBody (Encode.object [ ( "name", Encode.string "Elm" ) ]) of
                                            Err _ ->
                                                Task.fail "json-body"

                                            Ok body ->
                                                case
                                                    Http.request
                                                        { method = Http.postMethod
                                                        , url = target
                                                        , headers = [ Http.jsonRequestHeader ]
                                                        , body = body
                                                        , responseLimit = limit
                                                        , overLimit = Http.RejectOverLimit
                                                        , discardRedirectBody = False
                                                        }
                                                of
                                                    Err _ ->
                                                        Task.fail "request"

                                                    Ok request ->
                                                        Http.send origins deadline request
                                                            |> Task.mapError httpError
                                                            |> Task.andThen
                                                                (Http.bodyText
                                                                    >> Result.mapError bodyError
                                                                    >> resultToTask
                                                                )

                                    _ ->
                                        Http.send origins deadline base
                                            |> Task.mapError httpError
                                            |> Task.andThen
                                                (Http.bodyText
                                                    >> Result.mapError bodyError
                                                    >> resultToTask
                                                )
                            )
            in
            ( (), Task.attempt Finished task )

        _ ->
            ( (), report (Encode.string "invalid flags") )


followOne : Http.OriginSet -> Http.Deadline -> Http.Request -> Task String String
followOne origins deadline firstRequest =
    Http.send origins deadline firstRequest
        |> Task.mapError httpError
        |> Task.andThen
            (\response ->
                if followsRedirect (Http.status response) then
                    case location response of
                        Nothing ->
                            Task.fail "missing-location"

                        Just reference ->
                            case Http.resolve (Http.responseUrl response) reference of
                                Err _ ->
                                    Task.fail "invalid-location"

                                Ok target ->
                                    if Http.allows origins target then
                                        Http.send origins deadline (Http.get target (limit32 ()))
                                            |> Task.mapError httpError
                                            |> Task.andThen decodeName

                                    else
                                        Task.fail "origin-not-allowed"

                else
                    Task.succeed ("not-followed-" ++ String.fromInt (Http.status response))
            )


followsRedirect : Int -> Bool
followsRedirect status =
    status
        == 301
        || status
        == 302
        || status
        == 303
        || status
        == 307
        || status
        == 308


limit32 : () -> Http.ResponseLimit
limit32 _ =
    case Http.responseLimit 32 of
        Ok limit ->
            limit

        Err _ ->
            -- Executable constant proof; package tests fail if this ever changes.
            limit32 ()


location : Http.Response -> Maybe String
location response =
    Http.headers response
        |> List.filter (Http.responseHeaderName >> (==) "location")
        |> List.head
        |> Maybe.map Http.responseHeaderValue


decodeName : Http.Response -> Task String String
decodeName response =
    Http.bodyJson (Decode.field "name" Decode.string) response
        |> Result.mapError bodyError
        |> resultToTask


resultToTask : Result error value -> Task error value
resultToTask result =
    case result of
        Ok value ->
            Task.succeed value

        Err error ->
            Task.fail error


httpError : Http.Error -> String
httpError error =
    case Http.errorKind error of
        Http.DeadlineExceeded ->
            "deadline"

        Http.ResponseTooLarge ->
            "too-large"

        Http.OriginNotAllowed ->
            "origin-not-allowed"

        _ ->
            "http"


bodyError : Http.BodyError -> String
bodyError error =
    case error of
        Http.BodyWasTruncated _ ->
            "truncated"

        Http.RedirectBodyWasDiscarded ->
            "discarded"

        Http.InvalidUtf8 ->
            "invalid-utf8"

        Http.InvalidJson _ ->
            "invalid-json"


update : Msg -> () -> ( (), Cmd Msg )
update (Finished result) model =
    ( model
    , report
        (case result of
            Ok value ->
                Encode.object [ ( "ok", Encode.string value ) ]

            Err error ->
                Encode.object [ ( "error", Encode.string error ) ]
        )
    )
