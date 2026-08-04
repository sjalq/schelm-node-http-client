# Fixture-only assembled kernel

`SchelmHttpFixture.js` is generated from `kernel-src/http-transaction.js` with observation sites retained. It is not part of `elm.json`, package archives, or production generated workers. Deterministic state tests inject operations into the same canonical machine directly; this artifact is the positive control for hook stripping.
