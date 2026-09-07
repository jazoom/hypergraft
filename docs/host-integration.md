# Host integration

Version 1 of the Rust crate targets Axum and Askama. A second host adapter is outside protocol version 1.

The [anonymous task list](../examples/reference/README.md) is the runnable composition. The snippets below omit application-specific types and domain work.

Complete host-boundary examples are available in the reference source:

- [Router composition and asset load](../examples/reference/src/main.rs)
- [CSP, exact Origin enforcement and no-store errors](../examples/reference/src/security.rs)
- [Bounded command extraction and rejection patches](../examples/reference/src/commands.rs)
- [Document responses and secret-safe error conversion](../examples/reference/src/pages.rs)
- [Live endpoint, admission guard and projection factory](../examples/reference/src/live.rs)

JavaScript is required for live projections and command patches. HTTP still serves each initial document, deep link, reload and canonical GET page. Real links and forms define navigation, queries and commands. A native POST without patch metadata receives a no-store 400 before domain work.

## Middleware order

The host mounts `hypergraft::middleware::classify` around browser routes. Classification sits outside Origin enforcement, session resolution, authorisation and handlers. It sits inside tracing and outer security headers. The middleware classifies metadata once. It inserts `GraftRequest`. It rejects invalid metadata before downstream work. It rejects non-patch POST requests before downstream work. It merges `Vary` after downstream completion.

Explicit non-Hypergraft POST boundaries stay outside this layer. Static assets and a stateless fallback stay outside this layer.

The reference application uses this request order:

1. Outer security headers on the whole app.
2. Classification on browser routes.
3. Origin enforcement for unsafe methods.
4. The command body limit.
5. The page or command handler.

Assets, the live socket and the fallback stay outside classification.

```rust
let browser = Router::new()
    .route("/tasks", get(pages::tasks).post(commands::create))
    .route("/tasks/{id}", get(pages::task))
    .route("/tasks/{id}/status", post(commands::status))
    .layer(commands::command_body_limit())
    .layer(middleware::from_fn(security::enforce_origin))
    .layer(middleware::from_fn(hypergraft::middleware::classify));
let assets = Router::new()
    .route("/assets/main.js", get(javascript))
    .route("/assets/style.css", get(stylesheet));
let app = Router::new()
    .merge(browser)
    .merge(assets)
    .merge(live::service())
    .route("/", get(home))
    .fallback(security::not_found)
    .layer(middleware::from_fn(security::security_headers))
    .with_state(state);
```

The last browser layer is the outermost for those routes. `classify` therefore runs before Origin enforcement. Here, `live::service()` is the reference application's wrapper, not the Hypergraft library function.

The Origin boundary accepts safe methods without an Origin header. Unsafe methods require exactly one Origin value that equals the configured public origin. Missing, duplicate and foreign Origins receive a no-store 403 before body extraction or domain work.

Read [Security](security.md) for the working CSP header and the Trusted Types policy.

## Authentication

The reference application is anonymous public data. It does not authenticate users. Origin checks and CSP still apply.

If the application serves private data, the host owns authentication and authorisation. That work sits after classification and Origin enforcement. It stays outside Hypergraft. `LiveGuard::bind` and `LiveGuard::revalidate` are the live equivalents.

Hypergraft does not require authentication for anonymous public data.

## Extractors and responses

Handlers must extract the narrowest accepted representation. Use `PageGraft` for a document-or-navigation page. Use `PatchGraft` for a patch-only command. Use `GraftRequest` when one route serves documents, navigation and form patches.

Build bounded responses with `PatchSet`, checked string targets, Askama templates, `PatchStatus` and `RetryAfter`.

`outcome::page_patch` builds a titled, single-target page patch. `outcome::children_patch` builds one retained-target patch from an Askama template. It accepts any patch status. `PatchSet::append` adds nodes to a retained target. `PatchSet::replace_location` adds a canonical location replacement to a complete command patch. `PatchSet::encode_live` rejects titles and locations.

`PatchSet::encode_progress` and `encode_final` reject location replacements. `outcome::stream_response` validates frame and byte limits. It requires one final frame. It wraps the frame stream as `Graft-Transfer: stream`. `outcome::command_navigation` builds a validated navigation envelope for patch-only commands. `outcome::page_redirect` selects a native 303 response or a navigation envelope after destination validation.

Hosts render documents and map `PatchBuildError` to their own secret-safe errors. A native document response uses `PatchStatus::status_code` for the same outcome.

Command handlers extract `PatchGraft` before the form body and before domain mutation.

A body limit alone does not produce a known patch rejection. The reference handles `Result<RawForm, RawFormRejection>` after its 4096-byte limit. It converts extraction and decoding failures into bounded 422 patches before mutation. It omits rejected body text and extractor diagnostics.

Patch construction failures become secret-safe no-store 500 responses. The browser treats an unsafe failure as uncertain and does not retry the command.

## Page navigation as a titled `main` patch

```html
<a href="/items" data-graft>Items</a>
<main id="main" tabindex="-1"><!-- server-rendered page content --></main>
```

```rust
use axum::response::Response;
use hypergraft::{outcome, PageGraft};

async fn items(graft: PageGraft) -> Result<Response, HostError> {
    let page = ItemsPage::load().await?;
    match graft {
        PageGraft::Document => render_document("Items", &page),
        PageGraft::Navigation => Ok(outcome::page_patch("Items", "main", &page)?),
    }
}
```

## Canonical GET form with one targeted projection

```html
<form method="get" action="/items" data-graft>
    <label>Search <input name="q" type="search" /></label>
    <button type="submit">Search</button>
</form>
<section id="item-results"><!-- server-rendered results --></section>
```

```rust
use axum::{extract::Query, response::Response};
use hypergraft::{outcome, GraftRequest, PatchStatus};

async fn item_index(
    graft: GraftRequest,
    Query(query): Query<ItemQuery>,
) -> Result<Response, HostError> {
    let page = ItemPage::load(query).await?;
    match graft {
        GraftRequest::Document => render_document("Items", &page),
        GraftRequest::Navigation => Ok(outcome::page_patch("Items", "main", &page)?),
        GraftRequest::Patch => Ok(outcome::children_patch(
            PatchStatus::Ok,
            "item-results",
            &page.results,
        )?),
    }
}
```

The reference list handler also patches disjoint filter and create-filter regions. A live form stays outside its patch target. Read the [anonymous task list](../examples/reference/README.md) for that layout.

## Command rejection and success navigation

```html
<form method="post" action="/settings" data-graft>
    <label>Value <input name="value" required /></label>
    <button type="submit">Save</button>
</form>
<section id="settings-form"><!-- server-rendered form fragment --></section>
```

```rust
use axum::{extract::Form, response::Response};
use hypergraft::{outcome, PatchGraft, PatchStatus};

async fn save_settings(
    _graft: PatchGraft,
    Form(form): Form<SettingsForm>,
) -> Result<Response, HostError> {
    if let Err(errors) = form.validate() {
        return Ok(outcome::children_patch(
            PatchStatus::UnprocessableEntity,
            "settings-form",
            &SettingsFragment { errors },
        )?);
    }
    persist_settings(form).await?;
    Ok(outcome::command_navigation("/settings")?)
}
```

This command snippet shows domain validation only. Axum's default `Form` rejection is not a Hypergraft patch.

For bounded body rejections, use the complete [reference command handlers](../examples/reference/src/commands.rs).

## Command patch with a canonical location

A command can update bounded targets and replace the current browser location.

```rust
let mut patches = PatchSet::new();
patches.children("item-results", &results)?;
patches.replace_location("/items/selected")?;
Ok(patches.respond(PatchStatus::Ok)?)
```

The browser changes the location only after the complete patch applies. The fixed history operation is `replace`.

The patch must update each live projection form that depends on the old location state. Hypergraft does not infer or copy host query parameters.

## Live GET projection

A connected `form[data-graft][data-graft-live]` describes one GET projection. The runtime opens one socket for all such forms in the document. Filter changes remain ordinary safe submissions. Domain events then patch the projection without a second browser request.

```html
<form id="item-filter" method="get" action="/items" data-graft data-graft-live>
    <label>Search <input name="q" type="search" /></label>
    <button type="submit">Search</button>
</form>
<section id="item-results"><!-- server-rendered results --></section>
```

Hosts compose a `LiveRouter` and supply one `LiveGuard`. They mount `live::service` at the configured endpoint. Hosts must not implement a socket loop, protocol codec, subscription map or reconnect policy.

`LiveGuard::bind` receives the upgrade extensions once and returns an opaque connection value. `LiveGuard::revalidate` receives that value before every refresh and returns a fresh context. The connection value can own a socket admission permit.

The reference guard is anonymous. It uses one process-local admission key. It does not invent a user identity. If the projection serves private data, the guard context must carry the authorised principal.

```rust
use hypergraft::live::{AdmissionPermit, GuardFailure, LiveGuard, SocketAdmission};

const ANONYMOUS_ADMISSION_KEY: &str = "anon";
const ANONYMOUS_SOCKET_LIMIT: usize = 8;

struct AnonymousConnection {
    _permit: AdmissionPermit<&'static str>,
}

#[derive(Clone)]
struct AnonymousGuard {
    admission: SocketAdmission<&'static str>,
}

impl LiveGuard for AnonymousGuard {
    type Connection = AnonymousConnection;
    type Context = ();

    async fn bind(
        &self,
        _extensions: &axum::http::Extensions,
    ) -> Result<Self::Connection, GuardFailure> {
        self.admission
            .try_acquire(ANONYMOUS_ADMISSION_KEY, ANONYMOUS_SOCKET_LIMIT)
            .map(|permit| AnonymousConnection { _permit: permit })
            .map_err(|_| GuardFailure::Retryable)
    }

    async fn revalidate(&self, _connection: &Self::Connection) -> Result<(), GuardFailure> {
        Ok(())
    }
}
```

Subscribe to invalidations before the first refresh snapshot.

```rust
use axum::extract::{RawQuery, State};
use hypergraft::{
    PatchSet,
    live::{self, LiveProjection, LiveReject, LiveRouter, broadcast_invalidations},
};

async fn items_live(
    State(state): State<AppState>,
    RawQuery(raw): RawQuery,
) -> Result<LiveProjection<()>, LiveReject> {
    let query = ItemQuery::parse(raw.as_deref().unwrap_or(""));
    let invalidations = state.items.subscribe();
    let store = state.items.clone();
    Ok(LiveProjection::new(
        broadcast_invalidations(invalidations),
        move |_ctx| {
            let query = query.clone();
            let store = store.clone();
            async move {
                PatchSet::new()
                    .with_children("item-results", &store.refresh(&query))
                    .map_err(|_| hypergraft::live::ProjectionError::Retire)
            }
        },
    ))
}

fn live_router() -> LiveRouter<AppState> {
    LiveRouter::new().route("/items", items_live).unwrap()
}
```

The host mounts `live::service(endpoint, config, live_router, guard)` at the configured path. The host derives `connect-src` from `LiveEndpoint::csp_connect_src`.

Read [Live](live.md) for projection ownership, lease behaviour and diagnostic fields.

## Streamed command recipe

The reference application does not stream progress. A long command can still send `Graft-Transfer: stream`. Each frame is one length-prefixed envelope. Progress frames apply while the form stays pending. The last frame settles the request.

`StreamBudget` counts each progress frame against the protocol limits. It reserves one final frame and one maximum final envelope. A typed capacity error reports exhaustion. The host can then suppress later progress frames. The host still sends one final frame. `outcome::stream_response` still enforces the stream limits.

```rust
use futures_util::Stream;
use hypergraft::{outcome, PatchSet, PatchStatus, StreamBudget, StreamFrame};

fn progress_frame(
    budget: &mut StreamBudget,
    line: &LogLine,
) -> Result<Option<StreamFrame>, hypergraft::PatchBuildError> {
    let frame = PatchSet::new().with_append("log", line)?.encode_progress()?;
    if budget.try_progress(&frame).is_err() {
        return Ok(None);
    }
    Ok(Some(frame))
}

fn final_frame(line: &LogLine) -> Result<StreamFrame, hypergraft::PatchBuildError> {
    PatchSet::new()
        .with_append("log", line)?
        .encode_final(PatchStatus::Ok)
}

fn stream_log(
    frames: impl Stream<Item = StreamFrame> + Send + 'static,
) -> axum::response::Response {
    outcome::stream_response(frames)
}
```

Do not stream a document response.

## Use from a host

Place this repository next to the host repository.

If the host crate is in `app/`, add this path dependency:

```toml
hypergraft = { path = "../../hypergraft" }
```

If the host root is next to this repository, add this npm dependency:

```json
"hypergraft": "file:../hypergraft"
```

Import the public browser entry:

```ts
import { startHypergraft } from "hypergraft/browser";
```

The public browser entry is `hypergraft/browser`. Private runtime modules are not a supported integration. The supported integration contains one bundled runtime copy.

Read [Protocol version 1](protocol-v1.md) for wire limits. Read [Browser runtime](browser-runtime.md) for request lifecycle.
