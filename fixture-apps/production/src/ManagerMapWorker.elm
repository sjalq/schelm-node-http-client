port module ManagerMapWorker exposing (main)

import Json.Encode as Encode
import Platform
import Schelm.Node.HttpClient as Http
import Schelm.Node.HttpClient.Cancelable as Cancelable
import Task


port report : Encode.Value -> Cmd msg


type BaseMsg
    = BaseStarted Cancelable.Operation
    | BaseFinished Cancelable.Operation (Result Http.Error Http.Response)


type MiddleMsg
    = MiddleStarted Cancelable.Operation
    | MiddleFinished Cancelable.Operation (Result Http.Error Http.Response)


type Msg
    = DeadlineReady Http.Deadline
    | Identity BaseMsg
    | Composed MiddleMsg
    | CancelIdentity BaseMsg
    | CancelComposed MiddleMsg


type alias Model =
    { url : String }


main : Program String Model Msg
main =
    Platform.worker { init = init, update = update, subscriptions = always Sub.none }


init url =
    case Http.timeout 5000 of
        Ok duration ->
            ( { url = url }, Http.startDeadline duration |> Task.perform DeadlineReady )

        Err _ ->
            ( { url = url }, report (Encode.string "invalid") )


update msg model =
    case msg of
        DeadlineReady deadline ->
            case prepared model.url of
                Just ( origins, request ) ->
                    let
                        base =
                            Cancelable.send
                                { onStarted = BaseStarted
                                , onFinished = BaseFinished
                                }
                                origins
                                deadline
                                request

                        identityMapped =
                            Cmd.map Basics.identity base

                        composed =
                            base
                                |> Cmd.map baseToMiddle
                                |> Cmd.map Composed
                    in
                    ( model
                    , Cmd.batch
                        [ Cmd.map Identity identityMapped
                        , composed
                        , Cancelable.send
                            { onStarted = BaseStarted >> CancelIdentity
                            , onFinished = \operation result -> CancelIdentity (BaseFinished operation result)
                            }
                            origins
                            deadline
                            request
                        , Cancelable.send
                            { onStarted = BaseStarted
                            , onFinished = BaseFinished
                            }
                            origins
                            deadline
                            request
                            |> Cmd.map baseToMiddle
                            |> Cmd.map CancelComposed
                        ]
                    )

                Nothing ->
                    ( model, report (Encode.string "invalid") )

        Identity baseMsg ->
            ( model, report (reportBase "identity" baseMsg) )

        Composed middleMsg ->
            ( model, report (reportMiddle "composition" middleMsg) )

        CancelIdentity baseMsg ->
            case baseMsg of
                BaseStarted operation ->
                    ( model, Cmd.batch [ report (event "cancel-identity-started"), Cmd.map Identity (Cancelable.cancel operation) ] )

                BaseFinished _ _ ->
                    ( model, report (event "cancel-identity-unexpected-finish") )

        CancelComposed middleMsg ->
            case middleMsg of
                MiddleStarted operation ->
                    ( model, Cmd.batch [ report (event "cancel-composition-started"), Cmd.map Composed (Cancelable.cancel operation) ] )

                MiddleFinished _ _ ->
                    ( model, report (event "cancel-composition-unexpected-finish") )


baseToMiddle : BaseMsg -> MiddleMsg
baseToMiddle baseMsg =
    case baseMsg of
        BaseStarted operation ->
            MiddleStarted operation

        BaseFinished operation result ->
            MiddleFinished operation result


prepared url =
    case ( Http.url url, Http.method "GET", Http.responseLimit 1024 ) of
        ( Ok target, Ok get, Ok limit ) ->
            case Http.request { method = get, url = target, headers = [], body = Http.emptyBody, responseLimit = limit, overLimit = Http.RejectOverLimit, discardRedirectBody = False } of
                Ok request ->
                    Just ( Http.originSet (Http.origin target) [], request )

                Err _ ->
                    Nothing

        _ ->
            Nothing


reportBase prefix baseMsg =
    case baseMsg of
        BaseStarted _ ->
            event (prefix ++ "-started")

        BaseFinished _ _ ->
            event (prefix ++ "-finished")


reportMiddle prefix middleMsg =
    case middleMsg of
        MiddleStarted _ ->
            event (prefix ++ "-started")

        MiddleFinished _ _ ->
            event (prefix ++ "-finished")


event kind =
    Encode.object [ ( "kind", Encode.string kind ) ]
