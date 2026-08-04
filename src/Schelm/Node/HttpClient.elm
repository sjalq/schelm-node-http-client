module Schelm.Node.HttpClient exposing
    ( Url, UrlError(..), url, resolve, urlToRequestString, urlForDiagnostic
    , Origin, OriginSet, origin, originSet, allows
    , Method, MethodError(..), method, getMethod, postMethod
    , RequestHeader, RequestHeaderError(..), requestHeader, jsonRequestHeader
    , ResponseHeader, responseHeaderName, responseHeaderValue
    , Body, emptyBody, utf8Body, jsonBody, bytesBody, bodyByteLength
    , ResponseLimit, LimitError(..), responseLimit
    , Timeout, TimeoutError(..), timeout, Deadline, startDeadline
    , OverLimit(..), Request, RequestError(..), request, get, withHeader, withBody
    , Response, ResponseBody(..), BodyError(..), status, statusText, headers, setCookies, responseUrl, responseBody, bodyBytes, bodyText, bodyJson
    , Error, ErrorKind(..), errorKind, errorMessage, errorCode
    , send
    )

{-| Cooperative, bounded, one-shot buffered HTTP for pinned Node 24.4.1.

`OriginSet` is publicly mintable dependency scoping. It is not SSRF or DNS
rebinding protection. This module never follows redirects and has no streaming
API.

@docs Url, UrlError, url, resolve, urlToRequestString, urlForDiagnostic
@docs Origin, OriginSet, origin, originSet, allows
@docs Method, MethodError, method, getMethod, postMethod
@docs RequestHeader, RequestHeaderError, requestHeader, jsonRequestHeader
@docs ResponseHeader, responseHeaderName, responseHeaderValue
@docs Body, emptyBody, utf8Body, jsonBody, bytesBody, bodyByteLength
@docs ResponseLimit, LimitError, responseLimit
@docs Timeout, TimeoutError, timeout, Deadline, startDeadline
@docs OverLimit, Request, RequestError, request, get, withHeader, withBody
@docs Response, ResponseBody, BodyError, status, statusText, headers, setCookies, responseUrl, responseBody, bodyBytes, bodyText, bodyJson
@docs Error, ErrorKind, errorKind, errorMessage, errorCode
@docs send

-}

import Bytes exposing (Bytes)
import Bytes.Decode as BytesDecode
import Bytes.Encode as BytesEncode
import Elm.Kernel.SchelmHttp
import Json.Decode as JsonDecode exposing (Decoder)
import Json.Encode as JsonEncode
import Task exposing (Task)


type Url
    = Url RawUrl


type alias RawUrl =
    { request : String, diagnostic : String, origin : String }


type UrlError
    = InvalidUrl
    | UnsupportedScheme
    | UserInfoRejected
    | MissingHost


type Origin
    = Origin String


type OriginSet
    = OriginSet (List String)


type Method
    = Method String


type MethodError
    = InvalidMethod
    | ForbiddenMethod


type RequestHeader
    = RequestHeader String String


type RequestHeaderError
    = InvalidHeaderName
    | InvalidHeaderValue
    | ForbiddenHeader


type ResponseHeader
    = ResponseHeader String String


type Body
    = Empty
    | Utf8 Bytes
    | Binary Bytes


type ResponseLimit
    = ResponseLimit Int


type LimitError
    = LimitOutOfRange


type Timeout
    = Timeout Int


type TimeoutError
    = TimeoutOutOfRange


type Deadline
    = Deadline Float


type OverLimit
    = RejectOverLimit
    | TruncateOverLimit


type Request
    = Request RequestData


type alias RequestData =
    { method : String
    , url : RawUrl
    , headers : List { name : String, value : String }
    , body : Bytes
    , hasBody : Bool
    , responseLimit : Int
    , truncate : Bool
    , discardRedirectBody : Bool
    }


type RequestError
    = MethodDoesNotAllowBody
    | RequestBodyTooLarge
    | InvalidRequest


type Response
    = Response ResponseData


type alias ResponseData =
    { status : Int
    , statusText : String
    , headers : List ResponseHeader
    , setCookies : List String
    , url : Url
    , body : ResponseBody
    }


type ResponseBody
    = Complete Bytes
    | Truncated { prefix : Bytes, decodedLengthAtLeast : Int }
    | DiscardedRedirectBody


{-| Why a response body cannot be decoded as requested.

`BodyWasTruncated` and `RedirectBodyWasDiscarded` are deliberate request
outcomes, not malformed data. Raise the limit or change the request policy.

-}
type BodyError
    = BodyWasTruncated { receivedAtLeast : Int }
    | RedirectBodyWasDiscarded
    | InvalidUtf8
    | InvalidJson JsonDecode.Error


type Error
    = Error { kind : ErrorKind, site : String, code : Maybe String, message : String }


type ErrorKind
    = InvalidRequestError
    | OriginNotAllowed
    | DeadlineExceeded
    | ResponseTooLarge
    | NetworkFailure
    | UnsupportedRuntime
    | UnknownFailure


type alias RawError =
    { kind : String, site : String, code : String }


type alias RawResponse =
    { status : Int
    , statusText : String
    , headers : List { name : String, value : String }
    , setCookies : List String
    , url : RawUrl
    , bodyKind : String
    , body : Bytes
    , decodedLengthAtLeast : Int
    }


url : String -> Result UrlError Url
url raw =
    decodeUrl (Elm.Kernel.SchelmHttp.parseUrl raw)


resolve : Url -> String -> Result UrlError Url
resolve (Url base) reference =
    decodeUrl (Elm.Kernel.SchelmHttp.resolveUrl base.request reference)


urlToRequestString : Url -> String
urlToRequestString (Url value) =
    value.request


urlForDiagnostic : Url -> String
urlForDiagnostic (Url value) =
    value.diagnostic


origin : Url -> Origin
origin (Url value) =
    Origin value.origin


originSet : Origin -> List Origin -> OriginSet
originSet (Origin first) rest =
    OriginSet (unique (first :: List.map (\(Origin item) -> item) rest))


allows : OriginSet -> Url -> Bool
allows (OriginSet values) (Url value) =
    List.any ((==) value.origin) values


{-| Validate an HTTP method. Prefer `getMethod` and `postMethod` for common
requests.
-}
method : String -> Result MethodError Method
method raw =
    let
        upper =
            String.toUpper raw
    in
    if String.isEmpty raw || not (List.all isTokenChar (String.toList raw)) then
        Err InvalidMethod

    else if upper == "CONNECT" || upper == "TRACE" then
        Err ForbiddenMethod

    else
        Ok (Method upper)


{-| The validated GET method.
-}
getMethod : Method
getMethod =
    Method "GET"


{-| The validated POST method.
-}
postMethod : Method
postMethod =
    Method "POST"


requestHeader : String -> String -> Result RequestHeaderError RequestHeader
requestHeader rawName value =
    let
        name =
            String.toLower rawName
    in
    if String.isEmpty name || not (List.all isTokenChar (String.toList name)) then
        Err InvalidHeaderName

    else if String.any (\c -> c == '\u{0000}' || c == '\u{000D}' || c == '\n') value then
        Err InvalidHeaderValue

    else if forbiddenHeader name then
        Err ForbiddenHeader

    else
        Ok (RequestHeader name value)


{-| The JSON content type header.
-}
jsonRequestHeader : RequestHeader
jsonRequestHeader =
    RequestHeader "content-type" "application/json"


responseHeaderName : ResponseHeader -> String
responseHeaderName (ResponseHeader name _) =
    name


responseHeaderValue : ResponseHeader -> String
responseHeaderValue (ResponseHeader _ value) =
    value


emptyBody : Body
emptyBody =
    Empty


utf8Body : String -> Result RequestError Body
utf8Body value =
    let
        bytes =
            BytesEncode.encode (BytesEncode.string value)
    in
    boundedBody Utf8 bytes


{-| Encode a JSON value as a bounded UTF-8 request body. Add
`jsonRequestHeader` explicitly so content-type policy stays visible.
-}
jsonBody : JsonEncode.Value -> Result RequestError Body
jsonBody value =
    utf8Body (JsonEncode.encode 0 value)


bytesBody : Bytes -> Result RequestError Body
bytesBody value =
    boundedBody Binary (Elm.Kernel.SchelmHttp.copyBytes value)


bodyByteLength : Body -> Int
bodyByteLength value =
    case value of
        Empty ->
            0

        Utf8 bytes ->
            Bytes.width bytes

        Binary bytes ->
            Bytes.width bytes


responseLimit : Int -> Result LimitError ResponseLimit
responseLimit value =
    if value >= 1 && value <= 8 * 1024 * 1024 then
        Ok (ResponseLimit value)

    else
        Err LimitOutOfRange


timeout : Int -> Result TimeoutError Timeout
timeout value =
    if value >= 1 && value <= 120000 then
        Ok (Timeout value)

    else
        Err TimeoutOutOfRange


startDeadline : Timeout -> Task Never Deadline
startDeadline (Timeout milliseconds) =
    Elm.Kernel.SchelmHttp.startDeadline milliseconds |> Task.map Deadline


request :
    { method : Method
    , url : Url
    , headers : List RequestHeader
    , body : Body
    , responseLimit : ResponseLimit
    , overLimit : OverLimit
    , discardRedirectBody : Bool
    }
    -> Result RequestError Request
request config =
    let
        (Method methodValue) =
            config.method

        (Url urlValue) =
            config.url

        (ResponseLimit limitValue) =
            config.responseLimit

        bodyWidth =
            bodyByteLength config.body

        bodyIsEmptyConstructor =
            case config.body of
                Empty ->
                    True

                Utf8 _ ->
                    False

                Binary _ ->
                    False
    in
    if (methodValue == "GET" || methodValue == "HEAD") && not bodyIsEmptyConstructor then
        Err MethodDoesNotAllowBody

    else if bodyWidth > 8 * 1024 * 1024 then
        Err RequestBodyTooLarge

    else
        Ok <|
            Request
                { method = methodValue
                , url = urlValue
                , headers = List.map (\(RequestHeader name value) -> { name = name, value = value }) config.headers
                , body = encodeBody config.body
                , hasBody = not bodyIsEmptyConstructor
                , responseLimit = limitValue
                , truncate = config.overLimit == TruncateOverLimit
                , discardRedirectBody = config.discardRedirectBody
                }


{-| Build the ordinary bounded GET request. It rejects an oversized response
rather than silently truncating it. Use `request` when you need headers,
truncation, or redirect-body discard.
-}
get : Url -> ResponseLimit -> Request
get (Url urlValue) (ResponseLimit limitValue) =
    Request
        { method = "GET"
        , url = urlValue
        , headers = []
        , body = encodeBody emptyBody
        , hasBody = False
        , responseLimit = limitValue
        , truncate = False
        , discardRedirectBody = False
        }


{-| Add one already validated request header.
-}
withHeader : RequestHeader -> Request -> Request
withHeader (RequestHeader name value) (Request data) =
    Request { data | headers = { name = name, value = value } :: data.headers }


{-| Replace the one request body, rechecking method and hard-size invariants.
-}
withBody : Body -> Request -> Result RequestError Request
withBody newBody (Request data) =
    let
        empty =
            case newBody of
                Empty ->
                    True

                _ ->
                    False
    in
    if (data.method == "GET" || data.method == "HEAD") && not empty then
        Err MethodDoesNotAllowBody

    else if bodyByteLength newBody > 8 * 1024 * 1024 then
        Err RequestBodyTooLarge

    else
        Ok
            (Request
                { data
                    | body = encodeBody newBody
                    , hasBody = not empty
                }
            )


status : Response -> Int
status (Response value) =
    value.status


statusText : Response -> String
statusText (Response value) =
    value.statusText


headers : Response -> List ResponseHeader
headers (Response value) =
    value.headers


setCookies : Response -> List String
setCookies (Response value) =
    value.setCookies


responseUrl : Response -> Url
responseUrl (Response value) =
    value.url


responseBody : Response -> ResponseBody
responseBody (Response value) =
    value.body


{-| Return bytes only when the complete response body is available.
-}
bodyBytes : Response -> Result BodyError Bytes
bodyBytes response =
    case responseBody response of
        Complete bytes ->
            Ok bytes

        Truncated details ->
            Err (BodyWasTruncated { receivedAtLeast = details.decodedLengthAtLeast })

        DiscardedRedirectBody ->
            Err RedirectBodyWasDiscarded


{-| Strictly decode a complete UTF-8 response body. Invalid UTF-8 is an error;
this helper never inserts replacement characters deliberately.
-}
bodyText : Response -> Result BodyError String
bodyText response =
    bodyBytes response
        |> Result.andThen
            (\bytes ->
                BytesDecode.decode (BytesDecode.string (Bytes.width bytes)) bytes
                    |> Result.fromMaybe InvalidUtf8
            )


{-| Decode JSON from a complete, valid UTF-8 response body.
-}
bodyJson : Decoder value -> Response -> Result BodyError value
bodyJson decoder response =
    bodyText response
        |> Result.andThen
            (JsonDecode.decodeString decoder
                >> Result.mapError InvalidJson
            )


errorKind : Error -> ErrorKind
errorKind (Error value) =
    value.kind


errorMessage : Error -> String
errorMessage (Error value) =
    value.message


errorCode : Error -> Maybe String
errorCode (Error value) =
    value.code


send : OriginSet -> Deadline -> Request -> Task Error Response
send (OriginSet origins) (Deadline deadline) (Request config) =
    Elm.Kernel.SchelmHttp.send origins deadline config
        |> Task.map decodeResponse
        |> Task.mapError decodeError


boundedBody : (Bytes -> Body) -> Bytes -> Result RequestError Body
boundedBody ctor bytes =
    if Bytes.width bytes > 8 * 1024 * 1024 then
        Err RequestBodyTooLarge

    else
        Ok (ctor bytes)


encodeBody : Body -> Bytes
encodeBody value =
    case value of
        Empty ->
            BytesEncode.encode (BytesEncode.sequence [])

        Utf8 bytes ->
            bytes

        Binary bytes ->
            bytes


decodeUrl : { ok : Bool, reason : String, value : RawUrl } -> Result UrlError Url
decodeUrl raw =
    if raw.ok then
        Ok (Url raw.value)

    else
        case raw.reason of
            "scheme" ->
                Err UnsupportedScheme

            "userinfo" ->
                Err UserInfoRejected

            "host" ->
                Err MissingHost

            _ ->
                Err InvalidUrl


decodeResponse : RawResponse -> Response
decodeResponse raw =
    let
        decodedBody =
            case raw.bodyKind of
                "truncated" ->
                    Truncated { prefix = raw.body, decodedLengthAtLeast = raw.decodedLengthAtLeast }

                "discarded-redirect" ->
                    DiscardedRedirectBody

                _ ->
                    Complete raw.body
    in
    Response
        { status = raw.status
        , statusText = raw.statusText
        , headers = List.map (\item -> ResponseHeader item.name item.value) raw.headers
        , setCookies = raw.setCookies
        , url = Url raw.url
        , body = decodedBody
        }


decodeError : RawError -> Error
decodeError raw =
    let
        kind =
            case raw.kind of
                "invalid-request" ->
                    InvalidRequestError

                "origin-not-allowed" ->
                    OriginNotAllowed

                "deadline-exceeded" ->
                    DeadlineExceeded

                "response-too-large" ->
                    ResponseTooLarge

                "network-failure" ->
                    NetworkFailure

                "unsupported-runtime" ->
                    UnsupportedRuntime

                _ ->
                    UnknownFailure

        code =
            if String.isEmpty raw.code then
                Nothing

            else
                Just raw.code

        message =
            errorKindText kind ++ " at " ++ raw.site
    in
    Error { kind = kind, site = raw.site, code = code, message = message }


errorKindText : ErrorKind -> String
errorKindText kind =
    case kind of
        InvalidRequestError ->
            "invalid HTTP request"

        OriginNotAllowed ->
            "HTTP origin not allowed"

        DeadlineExceeded ->
            "HTTP deadline exceeded"

        ResponseTooLarge ->
            "HTTP response exceeded decoded byte limit"

        NetworkFailure ->
            "HTTP network failure"

        UnsupportedRuntime ->
            "unsupported Node Fetch runtime"

        UnknownFailure ->
            "unknown HTTP failure"


unique : List String -> List String
unique values =
    List.foldr
        (\value acc ->
            if List.any ((==) value) acc then
                acc

            else
                value :: acc
        )
        []
        values


isTokenChar : Char -> Bool
isTokenChar char =
    let
        code =
            Char.toCode char
    in
    (code >= 48 && code <= 57)
        || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || String.contains (String.fromChar char) "!#$%&'*+-.^_`|~"


forbiddenHeader : String -> Bool
forbiddenHeader name =
    List.any ((==) name)
        [ "connection"
        , "content-length"
        , "host"
        , "keep-alive"
        , "te"
        , "trailer"
        , "transfer-encoding"
        , "upgrade"
        , "cookie"
        , "set-cookie"
        , "authorization"
        , "proxy-authorization"
        , "proxy-authenticate"
        , "proxy-connection"
        ]
        || String.startsWith "proxy-" name
