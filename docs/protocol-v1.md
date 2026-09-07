# Protocol version 1

Hypergraft version 1 is a bounded HTML-over-HTTP and WebSocket protocol.
[`protocol-v1.json`](../protocol-v1.json) is the canonical wire fixture.
This document describes those wire rules and the request lifecycle.
It does not add messages or numerical limits.

## Wire contract

Enhanced requests send exactly one `Graft-Request` header.
The value is `navigation` or `patch`.
They send exactly one `Accept` header.
The value is `text/vnd.hypergraft.patches+html`.
The server rejects missing, duplicate or unknown metadata.
Ordinary GET requests receive documents.
A native POST without patch metadata receives a no-store 400 before domain work.

Responses use `Content-Type: text/vnd.hypergraft.patches+html` and `Cache-Control: no-store`.
They merge `Graft-Request` and `Accept` into `Vary` as distinct tokens.
`Graft-Transfer` defaults to `complete` and also accepts `stream`.

Complete patch statuses are 200, 401, 409, 422 and 429.
A 429 response carries a positive `Retry-After` value.
Navigation uses status 200.
Stream statuses are 200, 401, 409 and 422.

A complete envelope contains one `graft-patch-set` root with `version="1"`.
It contains 1–16 `graft-patch` elements with unique targets.
Each patch has `operation` and `target` attributes and one `template` child.
Operations are `children` and `append`.
A complete batch can carry a `title` attribute.
See [`complete-envelope-children`](../protocol-v1.json).

A navigation envelope instead carries `navigate` and contains no patches.
Its destination is a local path and query without a fragment.
Stream phases are `progress` and `final`.

A target identifier matches `^[A-Za-z][A-Za-z0-9_.:-]{0,127}$`.
It is ASCII.
It is at most 128 bytes.

## Wire limits

The fixture publishes these numerical bounds:

- Response envelope: 1048576 bytes
- Patch count: 16
- Stream frames: 256
- Stream bytes: 16777216
- Live subscriptions: 64
- Projection URL: 8192 bytes
- Control message: 16384 bytes
- Inbound controls: 4096
- Outbound messages: 4096, with pings in that count
- Outbound bytes: 134217728
- Lease: 300 seconds
- Heartbeat: 15 seconds

Exact URL and identifier lengths are accept cases.
One extra byte is a `protocol` rejection.
The boundary cases are:

- [`control-subscribe-url-at-byte-limit`](../protocol-v1.json)
- [`control-subscribe-url-over-byte-limit`](../protocol-v1.json)
- [`control-message-at-byte-limit`](../protocol-v1.json)
- [`control-message-over-byte-limit`](../protocol-v1.json)
- [`dom-id-at-byte-limit`](../protocol-v1.json)
- [`dom-id-over-byte-limit`](../protocol-v1.json)

## Host responsibilities

The host classifies request metadata before Origin enforcement and before handlers.
The host rejects a native POST without patch metadata before domain work.
The host builds envelopes with `PatchSet` and checked identifiers.

The host maps `PatchBuildError` to secret-safe errors.
The host owns authentication and authorisation for private data.
The host supplies one `LiveGuard` and projection factories.
The host does not implement a socket loop, protocol codec, subscription map or reconnect policy.

Rust construction enforces envelope bytes, patch count, duplicate targets and navigation shape.
It does not inspect the live document.
It does not count inserted nodes or nesting depth.

## Browser-document preflight

The browser validates a complete batch before any mutation.
Preflight checks document targets, overlap and final identifier uniqueness.
It enforces a maximum of 10000 inserted nodes and a nesting depth of 64.
These limits require DOM inspection, not just wire parsing.
The browser rejects a script element.
The browser rejects unknown envelope attributes.

Complete batch preflight does not promise rollback after an application-time exception.
`apply` mutates targets in sequence.
If an exception occurs after preflight, earlier morph work in that batch remains.

## Request cancellation

A client can cancel a safe GET or navigation.
A superseded or aborted safe request emits no settlement and no diagnostic.
The runtime does not apply a disposed safe response.

An unsafe command is not cancellable as if it never occurred.
The document-level unsafe guard stays in force until a known result or a reload.
Command and navigation startup suspend live work before safe-request cancellation releases retired forms.
A replacement GET owns its form retirement, so an older response cannot restore that form.

A replacement runtime inherits suspension from a pending or uncertain command before its first live reconciliation.
It cannot open a socket or schedule retries during that suspension.
A disposed command response requires a document reload, not live resumption.
Known command results restore eligible forms and resume live work.
Uncertain results leave live work suspended.

## Stream settlement

A host can send `Graft-Transfer: stream` with HTTP 200.
Each frame starts with its UTF-8 envelope byte length as ASCII decimal digits, then a newline.
The envelope follows immediately and is at most 1 MiB.
The stream byte limit includes length prefixes.
A progress frame has `phase="progress"` and applies without settlement.
The last frame has `phase="final"` and can carry `status="200|401|409|422"`.
The request settles only after that final frame and a clean end of body.

A stream cannot navigate.
A stream cannot carry 429.
An incomplete stream is a protocol failure.
Applied progress or final patches remain after a later stream failure.
Progress preserves the pending transport presentation.
Final cleanup respects the latest server-authored form attributes before settlement reaches host listeners.

## Command location replacements

Only a complete unsafe command patch can carry `location`.
The value is a validated local path and query without a fragment.
The browser replaces the current history entry after that patch applies.
A queued history traversal wins over that replacement.

A safe request rejects `location` before mutation.
A stream frame cannot carry `location`.
See [`stream-envelope-location-progress`](../protocol-v1.json) and [`stream-envelope-location-final`](../protocol-v1.json).

## Live envelopes

Live patches use binary frames.
Each frame has a 4-byte big-endian subscription header and one UTF-8 envelope.
Live envelopes cannot carry titles, navigation, locations, phases or statuses.
The rejection cases are:

- [`live-envelope-title`](../protocol-v1.json)
- [`live-envelope-location`](../protocol-v1.json)
- [`live-envelope-navigate`](../protocol-v1.json)

## Control rejection

Client controls are JSON text frames.
Required fields are closed per type.
The server rejects unknown fields.
The unknown-field cases are:

- [`control-subscribe-unknown-field`](../protocol-v1.json)
- [`control-unsubscribe-unknown-field`](../protocol-v1.json)
- [`control-terminal-unknown-field`](../protocol-v1.json)

`subscribe` requires `v`, `type`, `id` and `url`.
`unsubscribe` requires `v`, `type` and `id`.
`terminal` requires only `v` and `type` and ends the session without an acknowledgement.
An unknown unsubscribe identifier has no effect.

Missing fields and unknown control types are protocol failures.
See [`control-subscribe-missing-url`](../protocol-v1.json) and [`control-unknown-type`](../protocol-v1.json).

The version field must be the JSON string `"1"`.
A subscribe or unsubscribe identifier must be a uint32 of at least 1.
The identifier rejection cases are:

- [`control-subscribe-id-zero`](../protocol-v1.json)
- [`control-unsubscribe-id-zero`](../protocol-v1.json)
- [`control-subscribe-id-string`](../protocol-v1.json)

A subscribe URL must be a local GET path and query without a fragment.
See [`control-subscribe-https-url`](../protocol-v1.json) and [`control-subscribe-fragment-url`](../protocol-v1.json).

The server closes the socket with class `protocol` after an invalid control.

## Subscription identifier retirement

Each subscribe identifier is unique for the life of the socket.
`reuseOnSocket` is false.
Unsubscribe ends that subscription.
The identifier stays retired.
A later subscribe with the same identifier is a protocol close.
See [`subscription-id-reuse`](../protocol-v1.json) and [`subscription-id-reuse-after-unsubscribe`](../protocol-v1.json).

The browser ignores patches for retired identifiers.
A new socket starts identifiers at 1.

## Live lifecycle

The upgrade selects `hypergraft.v1` and negotiates no WebSocket extensions.
The server enforces the configured Origin.
The default endpoint is `/_hypergraft/live`.

The absolute lease starts before guard bind work.
Expiry cancels pending asynchronous bind, factory and revalidation work.
The deadline cannot interrupt host code that does not yield.
Pending factories count against subscription admission.
Unsubscribe and session termination cancel them and discard late results.

Fresh guard context precedes factory dispatch and every refresh.
The server sends a ping every 15 seconds and requires a pong.
Socket writes wait at most one heartbeat interval or the remaining lease, whichever ends first.
A stalled write is retryable unless the lease also expires.
Close delivery waits at most one heartbeat interval before resource release.

The browser reconnects after retryable, lease-expiry or resynchronisation closes.
Reconnect delays include jitter and stay between 1 and 30 seconds.
Terminal and protocol closes stop live work.
Lease or session-budget exhaustion uses `leaseExpiry`.

## Live harness

`LiveHarness` decodes live envelopes for host tests.
It is not a browser DOM validator.
`decode_live_envelope` checks wire grammar for operations, targets and templates.
It does not check live document targets, identifier uniqueness, node counts, nesting depth or script elements.

## Close classes

Closed live rejection classes are:

- `retryable` (4000)
- `terminal` (4001)
- `protocol` (4002)
- `leaseExpiry` (4003)
- `resynchronisation` (4004)

Named conformance cases use `accept` or one of those classes.
Control and envelope grammar failures use `protocol`.

## Conformance cases

The `cases` array in [`protocol-v1.json`](../protocol-v1.json) names executable examples.
Each case lists applicable consumers and an expectation of `accept` or `protocol`.
`protocol` denotes rejection, not a claim that every consumer closes a socket.
An optional `browserReason` specifies the browser diagnostic category when it differs from that shared expectation.
Byte-length cases generate otherwise valid inputs at the specified length.
Control byte-length cases pad a valid terminal control with JSON whitespace.

Consumers are:

- `rust-control`: `parse_control`
- `rust-socket`: live session identifier set
- `rust-live`: `PatchSet::encode_live` and `decode_live_envelope`
- `rust-response`: `PatchSet` stream builders and `DomId`
- `browser-preflight`: `preflight`
- `browser-preflight-live`: `preflightLive`
- `browser-preflight-frame`: `preflightFrame`
- `browser-control`: control messages that the browser produces

Tests feed those cases to production parsers and builders.
They do not add a second conformance codec.
Browser control tests assert only messages that the runtime sends.
