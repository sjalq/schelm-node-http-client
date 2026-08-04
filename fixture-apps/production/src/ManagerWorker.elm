port module ManagerWorker exposing (main)

import Json.Encode as E
import Platform
import Schelm.Node.HttpClient as Http
import Schelm.Node.HttpClient.Cancelable as Cancelable
import Task


port report : E.Value -> Cmd msg


port command : (String -> msg) -> Sub msg


type Msg
    = DeadlineReady Http.Deadline
    | Started Cancelable.Operation
    | Finished Cancelable.Operation (Result Http.Error Http.Response)
    | Command String


type alias Flags =
    { url : String, count : Int, cancel : Bool }


type alias Prepared =
    { origins : Http.OriginSet, request : Http.Request }


type alias Model =
    { prepared : Maybe Prepared
    , operations : List Cancelable.Operation
    , started : Int
    , finished : Int
    , target : Int
    , cancelImmediately : Bool
    }


main : Program Flags Model Msg
main =
    Platform.worker { init = init, update = update, subscriptions = \_ -> command Command }


init flags =
    case ( Http.url flags.url, Http.method "GET" ) of
        ( Ok target, Ok get ) ->
            case ( Http.responseLimit 1024, Http.timeout 5000 ) of
                ( Ok limit, Ok duration ) ->
                    case Http.request { method = get, url = target, headers = [], body = Http.emptyBody, responseLimit = limit, overLimit = Http.RejectOverLimit, discardRedirectBody = False } of
                        Ok request ->
                            ( { prepared = Just { origins = Http.originSet (Http.origin target) [], request = request }, operations = [], started = 0, finished = 0, target = flags.count, cancelImmediately = flags.cancel }
                            , Http.startDeadline duration |> Task.perform DeadlineReady
                            )

                        Err _ ->
                            invalid

                _ ->
                    invalid

        _ ->
            invalid


invalid =
    ( { prepared = Nothing, operations = [], started = 0, finished = 0, target = 0, cancelImmediately = False }
    , report (E.string "invalid")
    )


update msg model =
    case msg of
        DeadlineReady deadline ->
            case model.prepared of
                Just prepared ->
                    let
                        one =
                            Cancelable.send { onStarted = Started, onFinished = Finished } prepared.origins deadline prepared.request
                    in
                    ( { model | prepared = Nothing }, Cmd.batch (List.repeat model.target one) )

                Nothing ->
                    ( model, Cmd.none )

        Started operation ->
            let
                next =
                    { model | operations = operation :: model.operations, started = model.started + 1 }

                cancelCmd =
                    if model.cancelImmediately then
                        Cancelable.cancel operation

                    else
                        Cmd.none
            in
            ( next, Cmd.batch [ report (event "started" next.started next.finished), cancelCmd ] )

        Finished _ _ ->
            let
                next =
                    { model | finished = model.finished + 1 }
            in
            ( next, report (event "finished" next.started next.finished) )

        Command "cancel-all" ->
            ( model, Cmd.batch (List.map Cancelable.cancel model.operations) )

        Command _ ->
            ( model, Cmd.none )


event kind started finished =
    E.object [ ( "kind", E.string kind ), ( "started", E.int started ), ( "finished", E.int finished ) ]
