# Live

Hosts register projection factories and one connection guard. Hypergraft owns the socket session and the projection task lifecycle. Hosts must not implement a socket loop, protocol codec, subscription map or reconnect policy.

Read [Host integration](host-integration.md) for router composition. Read [Protocol version 1](protocol-v1.md) for wire limits and control rejection.

## Projection ownership

`LiveGuard::bind` receives the upgrade extensions once. It returns an opaque connection value. `LiveGuard::revalidate` receives that value before every refresh. It returns a fresh context. Fresh guard context precedes factory dispatch and every refresh. The connection value can own a `SocketAdmission` permit.

A projection factory maps one canonical GET path to a `LiveProjection`. Subscribe to invalidations before the first refresh snapshot. `broadcast_invalidations` turns a broadcast receiver into current-truth invalidations. Lag yields one refresh of current truth. A closed sender ends the stream.

Pending factories count against subscription admission before their asynchronous work starts. Unsubscribe and session termination cancel them. Late factory results are discarded. Hypergraft does not install those projections.

`LiveProjection::new` takes an invalidation stream and a refresh function. The refresh function receives the latest guard context. It returns a `PatchSet`. `PatchSet::encode_live` rejects titles, locations, phases and statuses. A failed encode retires that subscription only.

Nested invalidation listeners abort when their parent projection task is cancelled or dropped. Repeated unsubscribe and shutdown cleanup is idempotent.

Live patches target retained regions in the current document. Keep a live GET form outside its patch target. An open socket does not prove that every projection is current.

## Session lease and shutdown

The lease timer starts before host bind work. The default lease is five minutes. Expiry cancels a pending bind, a pending factory and a pending revalidation. The deadline cancels asynchronous host futures that yield. It cannot interrupt host code that does not yield.

One socket permits at most 64 active subscriptions. Each local projection URL is at most 8 KiB. Each control message is at most 16 KiB. The lease permits 4,096 controls, 4,096 outbound messages and 128 MiB of patch data. Pings count toward the outbound message budget.

Hypergraft sends a ping every 15 seconds and requires a pong. Socket writes wait at most one heartbeat interval or until the remaining lease ends, whichever is sooner. A stalled write is retryable unless the lease deadline also expires.

Close delivery waits at most one heartbeat interval. If the peer does not receive the close frame, Hypergraft still releases the socket and host resources. Shutdown cancels projection tasks and nested invalidation listeners.

The browser reconnects after lease expiry or a retryable close. Retry delays use bounded exponential backoff with jitter from 1 to 30 seconds. Protocol and terminal closes do not reconnect.

Pass `liveEndpoint` to `startHypergraft` only when the path is not `/_hypergraft/live`. Derive `connect-src` from `LiveEndpoint::csp_connect_src`.

## Diagnostics

Hypergraft emits structured `tracing` events at live socket failure boundaries. The library does not install a subscriber. The host installs a subscriber when it needs these events.

### Trace levels

Normal subscription retirement uses the DEBUG level. Lease expiry and lease budget use the INFO level. Guard, transport, protocol and resynchronisation failures use the WARN level. A failed live encode also uses the WARN level.

### Session close

The session emits one close event. The event records a closed `reason` field. The event records `close_class` when Hypergraft classifies the close. The event does not record the peer close reason.

`reason` is one of:

- `lease`
- `peer`
- `guard`
- `transport`
- `protocol`
- `budget`
- `resynchronisation`

`close_class` is one of:

- `retryable`
- `terminal`
- `protocol`
- `lease_expiry`
- `resynchronisation`

A `peer` close has no `close_class` field. Hypergraft does not send a close frame for that case.

`lease` means the session lease ends. `peer` means the peer closes the socket or sends a terminal control. `guard` means the connection guard fails. `transport` means a bounded write, a missed heartbeat or a socket receive fails.

`protocol` means the peer sends an invalid control. `budget` means an inbound or outbound lease budget ends the session. `resynchronisation` means a live frame header cannot be encoded.

### Projection encode

A failed `PatchSet::encode_live` call retires that subscription. The WARN event records `kind` from `PatchBuildError::kind`. The event does not record rendered HTML. The event does not record Askama error text.

`kind` is one of:

- `rendering`
- `duplicate_target`
- `patch_limit`
- `empty_batch`
- `invalid_target`
- `invalid_status`
- `invalid_location`
- `invalid_live_envelope`
- `response_limit`

### Subscription retirement

The DEBUG event `live subscription retired` records a closed `reason` field:

- `unregistered`: no projection factory matches the URL.
- `invalid`: the projection request is invalid.
- `projection`: the host rejects the subscription or retires its projection.
- `encode`: the live envelope fails to encode.

An encode failure emits its WARN event before the retirement event. Explicit unsubscribe and session cleanup do not emit retirement events.

### Secret exclusion

Library events do not record rendered HTML. Library events do not record exception text. Library events do not record request headers. Library events do not record projection URLs.

### Browser diagnostics

Browser `hypergraft:diagnostic` events can include the request URL. That URL can contain sensitive query values. Server live events do not include those URLs. Host policy for browser diagnostic logs remains a host concern.
