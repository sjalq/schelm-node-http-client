port module CancelWorker exposing (main)
import Json.Encode as E
import Platform
import Process
import Schelm.Node.HttpClient as Http
import Task
port report : E.Value -> Cmd msg
port command : (String -> msg) -> Sub msg
type Msg = Spawned Process.Id | Command String
type alias Model = { pid : Maybe Process.Id }
type alias Flags = { url : String }
main : Program Flags Model Msg
main = Platform.worker { init = init, update = update, subscriptions = \_ -> command Command }
init flags =
 case (Http.url flags.url,Http.method "GET") of
  (Ok target,Ok get) ->
   case (Http.responseLimit 1024,Http.timeout 5000) of
    (Ok limit,Ok duration) ->
     case Http.request {method=get,url=target,headers=[],body=Http.emptyBody,responseLimit=limit,overLimit=Http.RejectOverLimit,discardRedirectBody=False} of
      Ok req -> ({pid=Nothing}, Http.startDeadline duration |> Task.mapError never |> Task.andThen (\d -> Http.send (Http.originSet (Http.origin target) []) d req) |> Process.spawn |> Task.perform Spawned)
      Err _ -> invalid
    _ -> invalid
  _ -> invalid
invalid = ({pid=Nothing}, report (E.string "invalid"))
update msg model = case msg of
 Spawned pid -> ({pid=Just pid}, report (E.string "spawned"))
 Command "kill" -> case model.pid of
  Just pid -> ({pid=Nothing}, Process.kill pid |> Task.perform (\_ -> Command "killed"))
  Nothing -> (model, Cmd.none)
 Command "killed" -> (model, report (E.string "killed"))
 Command _ -> (model, Cmd.none)
