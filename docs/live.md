# Live

Hypergraft emits structured `tracing` events at live socket failure boundaries. The library does not install a subscriber. The host installs a subscriber when it needs these events.

## Trace levels

Normal subscription retirement uses the DEBUG level. Lease expiry and lease budget use the INFO level. Guard, transport, protocol and resynchronisation failures use the WARN level. A failed live encode also uses the WARN level.

## Session close

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

## Projection encode

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

## Subscription retirement

The DEBUG event `live subscription retired` records a closed `reason` field:

- `unregistered`: no projection factory matches the URL.
- `invalid`: the projection request is invalid.
- `projection`: the host rejects the subscription or retires its projection.
- `encode`: the live envelope fails to encode.

An encode failure emits its WARN event before the retirement event. Explicit unsubscribe and session cleanup do not emit retirement events.

## Secret exclusion

Library events do not record rendered HTML. Library events do not record exception text. Library events do not record request headers. Library events do not record projection URLs.

## Browser diagnostics

Browser `hypergraft:diagnostic` events can include the request URL. That URL can contain sensitive query values. Server live events do not include those URLs. Host policy for browser diagnostic logs remains a host concern.
