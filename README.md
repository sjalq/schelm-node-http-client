# sjalq/schelm-node-http-client

Private Elm 0.19.2 kernel package for cooperative, bounded, one-shot buffered HTTP on pinned Node 24.4.1.

V1 deliberately has no streaming, SSE, credentials, multipart, retries, or automatic redirects. `Schelm.Node.HttpClient.Cancelable` adds manager-owned cancellable buffered commands without changing the broad Task primitive. `OriginSet` prevents accidental origin confusion only; it is not SSRF or DNS-rebinding protection.

See `docs/design/05-design-revision-b.md` and `06-property-test-plan.md`.

Package-local implementation and evidence do **not** complete the harness cutover. Frozen legacy differential tests, poisoned old WebFetch route, Elm tool ownership, and full harness suites remain explicitly pending on a separate integration branch.
