"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const canonical = fs.readFileSync(path.join(root, "kernel-src/http-transaction.js"), "utf8");
const hash = crypto.createHash("sha256").update(canonical).digest("hex");
const start = canonical.indexOf("const FOLLOW_REDIRECT");
const end = canonical.indexOf("\nmodule.exports =");
if (start < 0 || end < 0) throw new Error("canonical machine markers missing");
const machine = canonical.slice(start, end);
const fixtureMarker = /\s*\/\* @fixture \*\/ return ops\.observe\(event, facts \|\| \{\}\);/g;
const productionMachine = machine.replace(fixtureMarker, " return undefined;");
const imports = `/*\nimport Elm.Kernel.Bytes exposing (width)\nimport Elm.Kernel.List exposing (fromArray, toArray)\nimport Elm.Kernel.Scheduler exposing (binding, fail, succeed)\n*/\n`;
const helpers = `
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
`;
function source(fixture) {
  const selected = fixture ? machine : productionMachine;
  const fixtureOps = fixture ? `\nvar $schelmFixtureEvents = [];\nfunction $schelmFixtureObserve(event, facts) { $schelmFixtureEvents.push({ event: event, facts: facts }); }\n` : "";
  return imports + `/* generated; canonical-sha256 ${hash}; fixture=${fixture} */\n` + selected + fixtureOps + helpers;
}
const targets = [
  ["src/Elm/Kernel/SchelmHttp.js", source(false)],
  ["fixtures/package/src/Elm/Kernel/SchelmHttpFixture.js", source(true)]
];
let bad = false;
for (const [rel, content] of targets) {
  const dest = path.join(root, rel);
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(dest) || fs.readFileSync(dest, "utf8") !== content) { console.error(`stale generated kernel: ${rel}`); bad = true; }
  } else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, content); }
}
if (bad) process.exit(1);
console.log(`${process.argv.includes("--check") ? "checked" : "assembled"} HTTP kernels ${hash}`);
