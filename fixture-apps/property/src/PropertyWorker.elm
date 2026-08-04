port module PropertyWorker exposing (main)

import Json.Encode as E
import Platform


port report : E.Value -> Cmd msg


type alias Model =
    ()


type Msg
    = Never


main : Program () Model Msg
main =
    Platform.worker
        { init = \_ -> ( (), report result )
        , update = \_ model -> ( model, Cmd.none )
        , subscriptions = always Sub.none
        }


result : E.Value
result =
    let
        sources =
            List.range 0 255

        limits =
            List.range 1 32

        cases =
            List.concatMap (\limit -> List.map (check limit) sources) limits

        failures =
            List.filter not cases
    in
    E.object
        [ ( "kind", E.string "property-result" )
        , ( "cases", E.int (List.length cases) )
        , ( "failures", E.int (List.length failures) )
        ]


check : Int -> Int -> Bool
check limit length =
    let
        source =
            if length <= 0 then
                []

            else
                List.range 0 (length - 1)

        retained =
            List.take limit source

        truncated =
            length > limit
    in
    List.length retained
        == min limit length
        && (not truncated || List.length retained == limit)
        && (truncated || retained == source)
