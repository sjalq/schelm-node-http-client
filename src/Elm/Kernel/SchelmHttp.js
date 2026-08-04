/*
import Elm.Kernel.Bytes exposing (width)
import Elm.Kernel.List exposing (fromArray, toArray)
import Elm.Kernel.Scheduler exposing (binding, fail, succeed)
*/
/* generated; canonical-sha256 6a472c1744d2537004eabe6b014afc400ed896b6db10be701e057113229cd2fd; fixture=false */
const FOLLOW_REDIRECT = new Set([301, 302, 303, 307, 308]);
const BODYLESS = new Set([204, 304]);
const ALLOWED_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND",
  "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT"
]);

function constructiveError(kind, site, exception) {
  const candidate = exception && typeof exception.code === "string" ? exception.code : "";
  return { kind, site, code: ALLOWED_CODES.has(candidate) ? candidate : "" };
}

function safeDetached(verb) {
  try {
    const value = verb();
    if (value && typeof value.then === "function") value.catch(function () {});
  } catch (_) {}
}

function runBufferedHttp(options) {
  const ops = options.ops;
  const request = options.request;
  let phase = "Prepared";
  let timer = null;
  let controller = null;
  let body = null;
  let reader = null;
  let pendingRead = false;
  let chunks = [];
  let kept = 0;

  function observe(event, facts) { return undefined;
  }

  function clearOwnedTimer() {
    if (timer !== null) {
      const owned = timer;
      timer = null;
      try { ops.clearTimer(owned); } catch (_) {}
    }
  }

  function cleanupTransport() {
    clearOwnedTimer();
    const ownedReader = reader;
    const ownedBody = body;
    const ownedController = controller;
    reader = null;
    body = null;
    controller = null;
    pendingRead = false;
    chunks = [];
    kept = 0;
    if (ownedController) safeDetached(function () { return ops.abort(ownedController); });
    if (ownedReader) {
      safeDetached(function () { return ops.cancelReader(ownedReader); });
      safeDetached(function () { return ops.releaseReader(ownedReader); });
    } else if (ownedBody) {
      safeDetached(function () { return ops.cancelBody(ownedBody); });
    }
  }

  function claim(next) {
    if (phase === "CallbackQueued" || phase === "Abandoned" || phase === "Absent") return false;
    phase = next;
    observe("TerminalClaimed", { phase: next });
    return true;
  }

  function deliver(kind, value) {
    if (!claim("CallbackQueued")) return;
    clearOwnedTimer();
    const ownedReader = reader;
    reader = null;
    body = null;
    controller = null;
    pendingRead = false;
    chunks = [];
    kept = 0;
    if (ownedReader) safeDetached(function () { return ops.releaseReader(ownedReader); });
    observe("CallbackQueued", { kind });
    try {
      if (kind === "success") ops.deliverSuccess(value);
      else ops.deliverFailure(value);
    } catch (_) {}
  }

  function fail(kind, site, exception, cancel) {
    if (!claim("Settling")) return;
    const error = constructiveError(kind, site, exception);
    if (cancel) cleanupTransport(); else clearOwnedTimer();
    phase = "CallbackQueued";
    observe("CallbackQueued", { kind: "failure", errorKind: kind, site });
    try { ops.deliverFailure(error); } catch (_) {}
  }

  function abandon() {
    if (!claim("Abandoned")) return;
    observe("Killed", {});
    cleanupTransport();
    phase = "Absent";
  }

  function copyPart(chunk, start, length) {
    try { return ops.copyChunk(chunk, start, length); }
    catch (error) { fail("unknown-failure", "copy-response-byte", error, true); return null; }
  }

  async function readResponse(response, facts) {
    if (phase === "Abandoned" || phase === "Absent") return;
    const status = facts.status;
    const discard = request.discardRedirectBody && FOLLOW_REDIRECT.has(status) && facts.hasLocation;
    if (request.method === "HEAD" || BODYLESS.has(status) || discard || !facts.body) {
      body = facts.body || null;
      phase = "ResponseNoBody";
      if (body) safeDetached(function () { return ops.cancelBody(body); });
      body = null;
      deliver("success", ops.makeResponse(facts, discard ? "discarded-redirect" : "complete", ops.emptyBytes(), 0));
      return;
    }

    body = facts.body;
    phase = "BeforeReader";
    try { reader = ops.acquireReader(body); }
    catch (error) { fail("network-failure", "acquire-reader", error, true); return; }
    if (!reader || typeof reader.read !== "function") {
      fail("unsupported-runtime", "acquire-reader", null, true);
      return;
    }
    body = null;
    phase = "ReaderIdle";

    while (phase === "ReaderIdle") {
      let packet;
      pendingRead = true;
      phase = "ReadPending";
      observe("ReadDispatched", { kept });
      try { packet = await ops.read(reader); }
      catch (error) {
        pendingRead = false;
        if (phase !== "Abandoned" && phase !== "Absent") fail("network-failure", "read-body", error, true);
        return;
      }
      pendingRead = false;
      if (phase === "Abandoned" || phase === "Absent") return;
      if (!packet || packet.done) {
        phase = "ReaderEnded";
        const bytes = (() => { try { return ops.concatChunks(chunks, kept); } catch (error) { fail("unknown-failure", "concat-response", error, true); return null; } })();
        if (bytes !== null && phase === "ReaderEnded") deliver("success", ops.makeResponse(facts, "complete", bytes, kept));
        return;
      }
      const chunk = packet.value;
      const size = ops.chunkLength(chunk);
      if (!Number.isSafeInteger(size) || size < 0) { fail("unsupported-runtime", "read-body", null, true); return; }
      observe("PhysicalChunk", { size, kept });
      if (size === 0) { phase = "ReaderIdle"; continue; }
      const room = request.responseLimit - kept;
      if (size <= room) {
        const copied = copyPart(chunk, 0, size);
        if (copied === null) return;
        chunks.push(copied);
        kept += size;
        phase = "ReaderIdle";
        continue;
      }
      if (room > 0) {
        const copied = copyPart(chunk, 0, room);
        if (copied === null) return;
        chunks.push(copied);
        kept += room;
      }
      if (request.truncate) {
        let prefix;
        try { prefix = ops.concatChunks(chunks, kept); }
        catch (error) { fail("unknown-failure", "concat-response", error, true); return; }
        if (!claim("Settling")) return;
        const responseValue = ops.makeResponse(facts, "truncated", prefix, request.responseLimit + 1);
        cleanupTransport();
        phase = "CallbackQueued";
        observe("CallbackQueued", { kind: "success", bodyKind: "truncated" });
        try { ops.deliverSuccess(responseValue); } catch (_) {}
      } else {
        fail("response-too-large", "read-body", null, true);
      }
      return;
    }
  }

  async function start() {
    let now;
    try { now = ops.nowMonotonic(); }
    catch (error) { fail("unknown-failure", "clock", error, false); return; }
    const remaining = options.deadline - now;
    if (!(remaining > 0)) { fail("deadline-exceeded", "before-dispatch", null, false); return; }
    let delay = Math.min(120000, Math.max(1, Math.ceil(remaining)));
    try { controller = ops.makeAbortController(); }
    catch (error) { fail("unsupported-runtime", "abort-controller", error, false); return; }
    try {
      timer = ops.setTimer(function () {
        fail("deadline-exceeded", "deadline", null, true);
      }, delay);
    } catch (error) { fail("unknown-failure", "set-timer", error, true); return; }
    phase = "BeforeResponse";
    observe("FetchDispatched", { delay });
    let fetchPromise;
    try { fetchPromise = ops.fetchManual(request, controller.signal); }
    catch (error) { fail("network-failure", "fetch", error, true); return; }
    let response;
    try { response = await fetchPromise; }
    catch (error) {
      if (phase !== "Abandoned" && phase !== "Absent" && phase !== "CallbackQueued") fail("network-failure", "fetch", error, true);
      return;
    }
    if (phase === "Abandoned" || phase === "Absent" || phase === "CallbackQueued") return;
    let facts;
    try { facts = ops.responseFacts(response, request); }
    catch (error) { fail("unsupported-runtime", "response-facts", error, true); return; }
    observe("PhysicalResponse", { status: facts.status });
    await readResponse(response, facts);
  }

  Promise.resolve().then(start).catch(function (error) {
    if (phase !== "Abandoned" && phase !== "Absent" && phase !== "CallbackQueued") fail("unknown-failure", "transaction", error, true);
  });

  return { kill: abandon, phase: function () { return phase; } };
}

function $rawUrlValue(u) {
  return { __$request: u.toString(), __$diagnostic: u.origin + "/<redacted>", __$origin: u.origin };
}
function $parseUrl(raw, base) {
  try {
    var u = base === undefined ? new URL(raw) : new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { __$ok: false, __$reason: "scheme", __$value: { __$request: "", __$diagnostic: "", __$origin: "" } };
    if (u.username || u.password) return { __$ok: false, __$reason: "userinfo", __$value: { __$request: "", __$diagnostic: "", __$origin: "" } };
    if (!u.hostname) return { __$ok: false, __$reason: "host", __$value: { __$request: "", __$diagnostic: "", __$origin: "" } };
    u.hash = "";
    return { __$ok: true, __$reason: "", __$value: $rawUrlValue(u) };
  } catch (_) { return { __$ok: false, __$reason: "invalid", __$value: { __$request: "", __$diagnostic: "", __$origin: "" } }; }
}
function $dataViewCopy(value) {
  var source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  var copy = new Uint8Array(source.byteLength); copy.set(source);
  return new DataView(copy.buffer);
}
var _SchelmHttp_parseUrl = function(raw) { return $parseUrl(raw); };
var _SchelmHttp_resolveUrl = F2(function(base, reference) { return $parseUrl(reference, base); });
var _SchelmHttp_copyBytes = function(value) { return $dataViewCopy(value); };
var _SchelmHttp_startDeadline = function(ms) {
  return __Scheduler_binding(function(callback) {
    var now; try { now = performance.now(); } catch (_) { now = Date.now(); }
    callback(__Scheduler_succeed(now + ms));
  });
};
function $requestFromElm(raw) {
  var headerItems = __List_toArray(raw.__$headers);
  var headers = new Headers();
  for (var i = 0; i < headerItems.length; i++) headers.append(headerItems[i].__$name, headerItems[i].__$value);
  var bytes = $dataViewCopy(raw.__$body);
  return {
    method: raw.__$method, url: raw.__$url.__$request, diagnostic: raw.__$url.__$diagnostic,
    expectedOrigin: raw.__$url.__$origin, headers: headers, bodyBytes: bytes,
    hasBody: raw.__$hasBody, responseLimit: raw.__$responseLimit,
    truncate: raw.__$truncate, discardRedirectBody: raw.__$discardRedirectBody
  };
}
function $makeOps(callback, allowedOrigins) {
  return {
    observe: function() {},
    nowMonotonic: function() { return performance.now(); },
    setTimer: function(fn, delay) { return setTimeout(fn, delay); },
    clearTimer: function(id) { clearTimeout(id); },
    makeAbortController: function() { return new AbortController(); },
    abort: function(controller) { controller.abort(); },
    fetchManual: function(req, signal) {
      if (allowedOrigins.indexOf(req.expectedOrigin) < 0) throw Object.assign(new Error(), { code: "SCHELM_ORIGIN" });
      var init = { method: req.method, headers: req.headers, redirect: "manual", signal: signal };
      if (req.hasBody) init.body = new Uint8Array(req.bodyBytes.buffer, req.bodyBytes.byteOffset, req.bodyBytes.byteLength);
      return fetch(req.url, init);
    },
    responseFacts: function(res, req) {
      if (!res || typeof res.status !== "number" || !res.headers) throw new Error();
      var responseUrl = res.url || req.url;
      var parsed = $parseUrl(responseUrl);
      if (!parsed.__$ok || parsed.__$value.__$request !== req.url) throw Object.assign(new Error(), { code: "SCHELM_RESPONSE_URL" });
      var headers = [];
      res.headers.forEach(function(value, name) { if (name !== "set-cookie") headers.push({ __$name: name, __$value: value }); });
      var setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      var location = res.headers.get("location");
      return {
        status: res.status, statusText: String(res.statusText || ""), headers: headers,
        setCookies: setCookies, url: parsed.__$value, body: res.body,
        hasLocation: typeof location === "string" && location.length > 0
      };
    },
    acquireReader: function(body) { return body.getReader(); },
    read: function(reader) { return reader.read(); },
    cancelBody: function(body) { return body.cancel(); },
    cancelReader: function(reader) { return reader.cancel(); },
    releaseReader: function(reader) { return reader.releaseLock(); },
    copyChunk: function(chunk, start, length) { var out = new Uint8Array(length); out.set(chunk.subarray(start, start + length)); return out; },
    chunkLength: function(chunk) { return chunk.byteLength; },
    concatChunks: function(chunks, total) { var out = new Uint8Array(total), offset = 0; for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], offset); offset += chunks[i].byteLength; } return new DataView(out.buffer); },
    emptyBytes: function() { return new DataView(new ArrayBuffer(0)); },
    makeResponse: function(facts, bodyKind, bodyValue, lowerBound) {
      return { __$status: facts.status, __$statusText: facts.statusText,
        __$headers: __List_fromArray(facts.headers), __$setCookies: __List_fromArray(facts.setCookies),
        __$url: facts.url, __$bodyKind: bodyKind, __$body: bodyValue,
        __$decodedLengthAtLeast: lowerBound };
    },
    deliverSuccess: function(value) { callback(__Scheduler_succeed(value)); },
    deliverFailure: function(error) {
      if (error.code === "SCHELM_ORIGIN") error = { kind: "origin-not-allowed", site: "before-dispatch", code: "" };
      callback(__Scheduler_fail({ __$kind: error.kind, __$site: error.site, __$code: error.code || "" }));
    }
  };
}
var _SchelmHttp_send = F3(function(origins, deadline, rawRequest) {
  return __Scheduler_binding(function(callback) {
    var operation;
    try {
      var request = $requestFromElm(rawRequest);
      var allowed = __List_toArray(origins);
      if (allowed.indexOf(request.expectedOrigin) < 0) {
        callback(__Scheduler_fail({ __$kind: "origin-not-allowed", __$site: "before-dispatch", __$code: "" }));
        return function() {};
      }
      operation = runBufferedHttp({ ops: $makeOps(callback, allowed), deadline: deadline, request: request });
    } catch (_) {
      callback(__Scheduler_fail({ __$kind: "invalid-request", __$site: "construct-request", __$code: "" }));
      return function() {};
    }
    return function() { operation.kill(); };
  });
});
