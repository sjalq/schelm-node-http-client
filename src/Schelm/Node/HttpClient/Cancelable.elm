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
    = Operation Int Int


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
    { nextSlot : Int
    , generations : Dict Int Int
    , active : Dict Int (Active msg)
    }


type alias Active msg =
    { generation : Int
    , pid : Process.Id
    , onFinished : Operation -> Result Http.Error Http.Response -> msg
    }


type SelfMsg
    = Completed Int Int (Result Http.Error Http.Response)


type alias MyRouter msg =
    Platform.Router msg SelfMsg


init : Task Never (State msg)
init =
    Task.succeed
        { nextSlot = 0
        , generations = Dict.empty
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
                slot =
                    state.nextSlot

                generation =
                    Dict.get slot state.generations
                        |> Maybe.withDefault 0
                        |> (+) 1

                operation =
                    Operation slot generation

                completionTask =
                    requestTask
                        |> Task.map Ok
                        |> Task.onError (Err >> Task.succeed)
                        |> Task.andThen (Completed slot generation >> Platform.sendToSelf router)
            in
            Process.spawn completionTask
                |> Task.andThen
                    (\pid ->
                        let
                            next =
                                { nextSlot = slot + 1
                                , generations = Dict.insert slot generation state.generations
                                , active =
                                    Dict.insert slot
                                        { generation = generation
                                        , pid = pid
                                        , onFinished = callbacks.onFinished
                                        }
                                        state.active
                                }
                        in
                        Platform.sendToApp router (callbacks.onStarted operation)
                            |> Task.andThen (\_ -> Task.succeed next)
                    )

        Cancel (Operation slot generation) ->
            case Dict.get slot state.active of
                Just active ->
                    if active.generation == generation then
                        let
                            next =
                                { state | active = Dict.remove slot state.active }
                        in
                        Process.kill active.pid
                            |> Task.andThen (\_ -> Task.succeed next)

                    else
                        Task.succeed state

                Nothing ->
                    Task.succeed state


onSelfMsg : MyRouter msg -> SelfMsg -> State msg -> Task Never (State msg)
onSelfMsg router (Completed slot generation result) state =
    case Dict.get slot state.active of
        Just active ->
            if active.generation == generation then
                let
                    operation =
                        Operation slot generation

                    next =
                        { state | active = Dict.remove slot state.active }
                in
                Platform.sendToApp router (active.onFinished operation result)
                    |> Task.andThen (\_ -> Task.succeed next)

            else
                Task.succeed state

        Nothing ->
            Task.succeed state
