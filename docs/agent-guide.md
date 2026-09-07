# Agent integration guide

This is the short reference for agents that build host applications with Hypergraft.

Hypergraft is an unpublished source preview for Axum and Askama. The Rust crate requires Rust 1.96 or later. Rust and browser APIs remain experimental. [`protocol-v1.json`](../protocol-v1.json) is the canonical version 1 wire contract.

## Mental model

- The server owns application state and renders authoritative HTML.
- HTTP serves a full document at each canonical GET URL. Deep links and reloads still work.
- Real links and forms describe requests. JavaScript is required for command patches and live projections.
- Hypergraft owns request classification and bounded response envelopes. It also owns one live socket per document.
- Hypergraft is not htmx. The server selects patch targets and operations, not client attributes.

## Connect a host

Place the Hypergraft checkout next to the host repository.

For the example below, add these Cargo dependencies to a host crate at its repository root:

```toml
[dependencies]
hypergraft = { path = "../hypergraft" }
askama = "0.16"
axum = "0.8"
serde = { version = "1", features = ["derive"] }
```

Add this dependency to the host's `package.json`:

```json
"hypergraft": "file:../hypergraft"
```

Adjust the paths for nested crates or packages.

Bundle imports from `hypergraft/browser` into one host asset.

Load that asset through an external module script in the document head.

## Request and response selection

| Route                    | Extractor      | Response                                                       |
| ------------------------ | -------------- | -------------------------------------------------------------- |
| GET page                 | `PageGraft`    | `Document`: full HTML. `Navigation`: titled page patch.        |
| GET page with a GET form | `GraftRequest` | The same two branches, plus `Patch`: targeted query results.   |
| POST command             | `PatchGraft`   | A known patch outcome or command navigation. Never a document. |

Marked links request navigation. Marked GET and POST forms request patches. The runtime supplies `Graft-Request` and `Accept`. A native POST without patch metadata receives a no-store 400 before domain work.

Enhanced commands require same-origin, fragment-free POST actions. Their encodings are `application/x-www-form-urlencoded` or `multipart/form-data`. Invalid command forms do not submit natively.

| Public API                                          | Purpose                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `outcome::page_patch(title, target, template)`      | A titled 200 `children` patch.                                                 |
| `outcome::children_patch(status, target, template)` | One `children` patch at an accepted status.                                    |
| `PatchSet::new().with_children(target, template)?`  | A batch builder. `with_append` adds an append operation.                       |
| `PatchSet::respond(status)`                         | A bounded, no-store response with the protocol content type and `Vary`.        |
| `outcome::command_navigation(path)`                 | A 200 navigation envelope that causes a full browser navigation.               |
| `outcome::page_redirect(graft, path)`               | A native 303 or navigation envelope, according to `PageGraft`.                 |
| `PatchSet::replace_location(path)`                  | A location replacement after a complete command patch. History uses `replace`. |

Accepted `PatchStatus` variants are:

- `Ok`: 200.
- `Unauthorized`: 401.
- `Conflict`: 409.
- `UnprocessableEntity`: 422.
- `TooManyRequests(RetryAfter)`: 429 with a positive `Retry-After` value.

`RetryAfter::seconds(n)` returns `None` for zero. Navigation and location destinations are local paths with optional queries, without fragments.

## Minimal page and command

This example edits one value at `/settings`. The host supplies persistence and security middleware. The 4096-byte body limit is an example choice, not a protocol limit.

### Templates

Create `templates/document.html` with this shell:

```html
<!DOCTYPE html>
<html lang="en-AU">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Settings</title>
        <script type="module" src="/assets/main.js"></script>
    </head>
    <body>
        <a href="/settings" data-graft>Settings</a>
        <main id="main" tabindex="-1">{{ body|safe }}</main>
    </body>
</html>
```

Create `templates/settings.html` with the contents of `main`, not another `main` element:

```html
<h1>Settings</h1>
<form method="post" action="/settings" data-graft>
    <label>Value <input name="value" value="{{ value }}" required /></label>
    <p role="alert">{{ error }}</p>
    <button type="submit">Save</button>
</form>
```

### Handlers

`load_value()` returns the stored `String`. `persist_value(&str)` stores a validated value and returns `()`. Both are asynchronous host functions with `Result` return types. Their errors implement `Display`.

```rust
use askama::Template;
use axum::{
    extract::{Form, rejection::FormRejection},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
};
use hypergraft::{PageGraft, PatchGraft, PatchStatus, outcome};
use serde::Deserialize;

#[derive(Template)]
#[template(path = "document.html")]
struct Document {
    body: String,
}

#[derive(Template)]
#[template(path = "settings.html")]
struct Settings {
    value: String,
    error: &'static str,
}

#[derive(Deserialize)]
struct Input {
    value: String,
}

fn internal(_: impl std::fmt::Display) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(header::CACHE_CONTROL, "no-store")],
        "Server error",
    )
        .into_response()
}

async fn settings(graft: PageGraft) -> Result<Response, Response> {
    let page = Settings {
        value: load_value().await.map_err(internal)?,
        error: "",
    };
    match graft {
        PageGraft::Document => {
            let body = page.render().map_err(internal)?;
            let html = Document { body }.render().map_err(internal)?;
            Ok(([(header::CACHE_CONTROL, "no-store")], Html(html)).into_response())
        }
        PageGraft::Navigation => outcome::page_patch("Settings", "main", &page).map_err(internal),
    }
}

async fn save_settings(
    _graft: PatchGraft,
    form: Result<Form<Input>, FormRejection>,
) -> Result<Response, Response> {
    let value = match form {
        Ok(Form(input)) if !input.value.trim().is_empty() => input.value,
        _ => {
            return outcome::children_patch(
                PatchStatus::UnprocessableEntity,
                "main",
                &Settings {
                    value: String::new(),
                    error: "Enter a non-empty value within the form limit.",
                },
            )
            .map_err(internal);
        }
    };
    persist_value(&value).await.map_err(internal)?;
    outcome::command_navigation("/settings").map_err(internal)
}
```

Only rendered Askama output supplies `body|safe`. The field values still receive HTML escaping. Extraction failures return bounded 422 patches before mutation. A plain `Form<Input>` extractor instead returns Axum's default rejection, not a known patch outcome.

### Router

Mount classification as the outermost browser layer:

```rust
use axum::{extract::DefaultBodyLimit, middleware, routing::get, Router};

let browser = Router::new()
    .route("/settings", get(settings).post(save_settings))
    .layer(DefaultBodyLimit::max(4096))
    .layer(middleware::from_fn(enforce_origin))
    .layer(middleware::from_fn(hypergraft::middleware::classify));
let app = Router::new()
    .merge(browser)
    .merge(assets)
    .fallback(not_found)
    .layer(middleware::from_fn(security_headers));
```

The host supplies the undefined router components. The last Axum layer runs first. Outer security headers cover errors too. Assets and the live service stay outside classification. Explicit non-Hypergraft POST routes also stay outside it.

### Browser startup and feedback

Place this feedback container before `main` in the document shell:

```html
<div data-graft-feedback hidden>
    <p data-graft-feedback-safe role="status">The request failed.</p>
    <p data-graft-feedback-uncertain role="alert" hidden>
        The result is uncertain.
    </p>
    <button type="button" data-graft-feedback-dismiss>Dismiss</button>
    <button type="button" data-graft-feedback-reload hidden>Reload</button>
</div>
```

Use this browser entry:

```ts
import { bindTransportFeedback, startHypergraft } from "hypergraft/browser";

const bound = bindTransportFeedback(document);
const stop = startHypergraft({ feedback: bound.feedback });

export function dispose(): void {
    stop();
    bound.destroy();
}
```

## Host security requirements

- Enforce Origin after classification and before body extraction or domain work.
- Reject unsafe requests unless exactly one Origin value exists and equals the configured public origin.
- Use no-store 403 responses for Origin rejections.
- For private data, resolve sessions between Origin enforcement and authorisation.
- For private data, enforce authorisation before handlers.
- Keep command body limits and domain validation before mutation.
- Render trusted templates with escaped user values.
- Do not expose form bodies or internal error details in error responses.
- Do not treat Hypergraft's Trusted Types policy as a sanitiser.
- Permit the `hypergraft` Trusted Types policy in CSP.
- Do not add `allow-duplicates` or a global passthrough policy.

### CSP baseline

This baseline supports same-origin external scripts and styles without live sockets:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types hypergraft
```

Live hosts also need the explicit WebSocket source from `LiveEndpoint::csp_connect_src` in `connect-src`.

## Patch and runtime constraints

- Target identifiers are global document IDs, not CSS selectors. Each target must exist and targets must not overlap.
- `children` retains its target and morphs its contents. `append` retains its target and adds last children.
- Every final document ID must match `^[A-Za-z][A-Za-z0-9_.:-]{0,127}$` and be unique, even outside patch targets.
- A batch contains 1–16 patches and at most 1048576 envelope bytes. Browser limits are 10000 inserted nodes and nesting depth 64.
- Patches cannot contain script elements.
- A title updates `document.title`, not the document head.
- Version 1 does not restore history scroll positions.
- Safe GET work is cancellable. An uncertain command keeps the document's unsafe lock and suspends live work until a reload.
- Server-authored form state wins after a patch. A retained DOM node does not prove request completion.

### Mistakes to avoid

- Do not invent target attributes or swap modes.
- Do not broaden version 1 wire fields or patch statuses.
- Do not return raw fragments or JSON to enhanced commands.
- Do not return 204 responses or ordinary redirects to enhanced commands.
- Do not retry an uncertain command.
- Do not unlock an uncertain command through runtime replacement.
- Do not import private browser modules.
- Do not bundle multiple runtime copies.
- Do not patch both a parent target and its descendant in one batch.
- Do not include a retained target's wrapper in its `children` content.

## Optional live projections

A GET form with `data-graft data-graft-live` declares one projection. Its canonical URL includes its successful form controls. The runtime shares one socket across eligible forms.

- Keep the live form outside its patch targets.
- Register projection factories with `LiveRouter`.
- Supply one `LiveGuard`.
- Mount `live::service` at the configured endpoint.
- Subscribe to invalidations before the first refresh snapshot.
- Use the fresh guard context for each authorised refresh.
- Return current-truth `PatchSet` values that contain only projection patches.

Leave these components to Hypergraft:

- Socket loops.
- Protocol codecs.
- Subscription maps.
- Reconnect policy.

## Read more only for the task

| Task                                                   | Additional reference                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Run the reference application                          | [`examples/reference/README.md`](../examples/reference/README.md)                  |
| Add GET query patches or command location replacements | [Host integration](host-integration.md)                                            |
| Add live projections                                   | [Live GET recipe](host-integration.md#live-get-projection), then [Live](live.md)   |
| Add streamed progress                                  | [Streamed command recipe](host-integration.md#streamed-command-recipe)             |
| Add an island                                          | [Island recipe](browser-runtime.md#island-recipe)                                  |
| Use lifecycle events or diagnose uncertainty           | [Browser runtime](browser-runtime.md)                                              |
| Change CSP or investigate Trusted Types                | [Security](security.md)                                                            |
| Change Hypergraft itself                               | [`AGENTS.md`](../AGENTS.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md)            |
| Change wire behaviour                                  | [`protocol-v1.json`](../protocol-v1.json) and [Protocol version 1](protocol-v1.md) |
