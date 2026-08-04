effect module Schelm.Node.HttpClient.Cancelable where { command = MyCmd } exposing (Operation, Callbacks, send, attempt, cancel)

{-| Cancellable command surface over `Schelm.Node.HttpClient.send`.

@docs Operation, Callbacks, send, attempt, cancel

-}

import Dict exposing (Dict)
import Platform
import Platform.Cmd exposing (Cmd)
import Process
import Schelm.Node.HttpClient as Http
import Task exposing (Task)


type Operation
    = Operation Int


type alias Callbacks msg =
    { onStarted : Operation -> msg
    , onFinished : Operation -> Result Http.Error Http.Response -> msg
    }


send : Callbacks msg -> Http.OriginSet -> Http.Deadline -> Http.Request -> Cmd msg
send callbacks origins deadline request =
    attempt callbacks (Http.send origins deadline request)


attempt : Callbacks msg -> Task Http.Error Http.Response -> Cmd msg
attempt callbacks task =
    command (Start callbacks task)


cancel : Operation -> Cmd msg
cancel operation =
    command (Cancel operation)


type MyCmd msg
    = Start (Callbacks msg) (Task Http.Error Http.Response)
    | Cancel Operation


cmdMap : (a -> b) -> MyCmd a -> MyCmd b
cmdMap func cmd =
    case cmd of
        Start callbacks task ->
            Start
                { onStarted = callbacks.onStarted >> func
                , onFinished = \operation result -> func (callbacks.onFinished operation result)
                }
                task

        Cancel operation ->
            Cancel operation


type alias State msg =
    { nextOperation : Int
    , active : Dict Int (Active msg)
    }


type alias Active msg =
    { pid : Process.Id
    , onFinished : Operation -> Result Http.Error Http.Response -> msg
    }


type SelfMsg
    = Completed Int (Result Http.Error Http.Response)


type alias MyRouter msg =
    Platform.Router msg SelfMsg


init : Task Never (State msg)
init =
    Task.succeed
        { nextOperation = 0
        , active = Dict.empty
        }


onEffects : MyRouter msg -> List (MyCmd msg) -> State msg -> Task Never (State msg)
onEffects router commands state =
    applyCommands router commands state


applyCommands : MyRouter msg -> List (MyCmd msg) -> State msg -> Task Never (State msg)
applyCommands router commands state =
    case commands of
        [] ->
            Task.succeed state

        command_ :: rest ->
            applyCommand router command_ state
                |> Task.andThen (applyCommands router rest)


applyCommand : MyRouter msg -> MyCmd msg -> State msg -> Task Never (State msg)
applyCommand router command_ state =
    case command_ of
        Start callbacks requestTask ->
            let
                operationId =
                    nextUnusedOperation state.nextOperation state.active

                operation =
                    Operation operationId

                completionTask =
                    requestTask
                        |> Task.map Ok
                        |> Task.onError (Err >> Task.succeed)
                        |> Task.andThen (Completed operationId >> Platform.sendToSelf router)
            in
            Process.spawn completionTask
                |> Task.andThen
                    (\pid ->
                        let
                            next =
                                { nextOperation = incrementOperation operationId
                                , active =
                                    Dict.insert operationId
                                        { pid = pid
                                        , onFinished = callbacks.onFinished
                                        }
                                        state.active
                                }
                        in
                        Platform.sendToApp router (callbacks.onStarted operation)
                            |> Task.andThen (\_ -> Task.succeed next)
                    )

        Cancel (Operation operationId) ->
            case Dict.get operationId state.active of
                Just active ->
                    let
                        next =
                            { state | active = Dict.remove operationId state.active }
                    in
                    Process.kill active.pid
                        |> Task.andThen (\_ -> Task.succeed next)

                Nothing ->
                    Task.succeed state


onSelfMsg : MyRouter msg -> SelfMsg -> State msg -> Task Never (State msg)
onSelfMsg router (Completed operationId result) state =
    case Dict.get operationId state.active of
        Just active ->
            let
                operation =
                    Operation operationId

                next =
                    { state | active = Dict.remove operationId state.active }
            in
            Platform.sendToApp router (active.onFinished operation result)
                |> Task.andThen (\_ -> Task.succeed next)

        Nothing ->
            Task.succeed state


maxOperation : Int
maxOperation =
    9007199254740990


incrementOperation : Int -> Int
incrementOperation operationId =
    if operationId >= maxOperation then
        0

    else
        operationId + 1


nextUnusedOperation : Int -> Dict Int (Active msg) -> Int
nextUnusedOperation candidate active =
    if Dict.member candidate active then
        nextUnusedOperation (incrementOperation candidate) active

    else
        candidate
