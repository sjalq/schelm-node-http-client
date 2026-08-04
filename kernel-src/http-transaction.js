"use strict";

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

  function observe(event, facts) {
    /* @fixture */ return ops.observe(event, facts || {});
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
    if (phase === "Abandoned" || phase === "Absent") return;
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

module.exports = { runBufferedHttp, constructiveError, FOLLOW_REDIRECT, BODYLESS };
