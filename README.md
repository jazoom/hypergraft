# Hypergraft

An HTML-over-HTTP protocol, browser runtime and server library for progressively enhanced server-rendered applications using Rust with Axum and Askama. It's kinda like htmx but with a smaller API and tight integration with the Rust server. It plays well with a strict CSP.

## Design goals

Hypergraft optimises for local reasoning. Pages remain ordinary server-rendered HTML with real links and forms. Enhancement uses a small, closed vocabulary. Client-owned state is limited to transport state and transient gestures that cannot be expressed by native HTML.

A proposed feature belongs in Hypergraft when it is reusable across hosts, preserves native behaviour, has a bounded declarative contract and removes more host concepts than it adds. Product presentation, domain policy, persistence and durable client state remain host-owned.

## Protocol version 1

Enhanced requests send exactly one `Graft-Request: navigation|patch` and exactly one `Accept: text/vnd.hypergraft.patches+html`. Missing, incomplete, duplicated or unknown metadata is rejected. Ordinary requests receive documents.

Responses use `text/vnd.hypergraft.patches+html`, `Cache-Control: no-store`, and token-aware `Vary: Graft-Request, Accept`. A complete patch envelope contains 1–16 unique `children` or `append` patches and may carry a title. Accepted complete patch statuses are 200, 401, 409, 422 and typed 429 responses carrying a positive `Retry-After`. Navigation is a validated local, fragment-free destination and status 200. [`protocol-v1.json`](protocol-v1.json) is the canonical conformance fixture.

A host can send `Graft-Transfer: stream` with HTTP 200 and a length-prefixed sequence of complete envelopes. Each frame is at most 1 MiB. A stream can contain at most 256 frames and 16 MiB in total. A progress frame has `phase="progress"` and applies without settling the request. The last frame has `phase="final"` and can carry `status="200|401|409|422"`. The request settles only after that final frame and a clean end of body. A stream cannot navigate, cannot carry 429, and an incomplete stream is a protocol failure.

Both server construction and browser reading enforce the 1 MiB envelope limit. Browser preflight additionally validates live targets, final identifier uniqueness, 10,000 inserted nodes and depth 64 before any mutation; Rust does not check those live-document properties.

## Rust host boundary

Mount `hypergraft::middleware::classify` around browser routes, outside Origin enforcement, session resolution, authorisation and handlers, but inside tracing and outer security headers. It classifies metadata once, inserts `GraftRequest`, rejects invalid metadata before downstream work and merges `Vary` after downstream completion. Static assets and a stateless fallback must stay outside this layer.

Handlers must extract the narrowest accepted representation: `PageGraft` for a document-or-navigation page and `CommandGraft` for a document-or-patch command. Build bounded responses with `PatchSet`, checked string targets, Askama templates, `PatchStatus` and `RetryAfter`. `outcome::page_patch` builds a titled single-target page patch. `outcome::children_patch` builds one retained-target patch at any accepted status from an Askama template. `PatchSet::append` adds nodes to a retained target. `PatchSet::encode_progress` and `encode_final` build length-prefixed stream frames. `outcome::stream_response` validates frame and byte limits, requires one final frame, and wraps the frame stream as `Graft-Transfer: stream`. `outcome::redirect` explicitly negotiates a native 303 or navigation envelope after validating the destination. Hosts retain document rendering and map `PatchBuildError` to their own secret-safe errors.

A native document response uses `PatchStatus::status_code` for the same outcome.

`StreamBudget` counts progress frames and reserves one final envelope. Hosts suppress progress when it returns a capacity error. `outcome::stream_response` remains the final check.

## Browser lifecycle, feedback and diagnostics

The browser entry point is side-effect free. `startHypergraft` creates one runtime instance and enhances only marked same-origin links and supported forms. Its returned stop function tears that instance down. A later `startHypergraft` call disposes the previous instance rather than poking module globals. `children` retains its target and morphs already parsed, preflighted nodes with server-authoritative attributes and form properties. `append` retains its target and adds preflighted nodes as last children. Compatible keyed descendants may be retained or moved within one target; no identity guarantee crosses targets. A retained node, a disconnection or a mutation record is never evidence that transport completed.

Safe work is cancellable. Teardown invalidates and aborts in-flight safe navigation and form requests, clears every live-form timer, restores pending state and clears safe-failure feedback. A disposed safe response must not patch, emit lifecycle events or call old feedback options.

An in-flight or uncertain unsafe command is not cancellable as though it never happened. Teardown must not unlock the document-level unsafe guard and permit another POST. That guard is preserved across runtime replacement. A final stop reloads immediately; if an old command returns after replacement, the replacement reloads authoritative state because the disposed runtime cannot apply the response. A disposed runtime never applies a patch, emits settlement or calls feedback.

Applied navigation focuses the first patched target when that target is programmatically focusable, then scrolls the window to `(0, 0)`. Version 1 does not restore history scroll positions: after a children patch the previous offset belongs to different content.

A streamed form request emits `hypergraft:progress` after each applied progress frame and sets `data-graft-progress` on the form until pending state is restored. It emits `hypergraft:requestsettled` only after the final frame, a clean end of body, and after pending and submitter state is final. A complete form request emits `hypergraft:requestsettled` only after its pending and submitter state is final. Its `RequestSettledDetail` contains the originating form, effective request URL, patch kind and one bounded outcome:

- A safe applied patch applies the whole preflighted batch and updates that form's failure state, reconciles history and emits its location fact, restores pending state, then emits `applied-patch` with an accepted status and authoritative target identifiers.
- A safe failure emits its diagnostic, records the failed source and requests safe feedback, restores pending state, then emits `safe-failure`.
- A superseded or aborted safe request emits neither a settlement nor a diagnostic. A valid navigation envelope uses `location.assign` and emits no settlement because the document is leaving.
- A known unsafe patch applies its batch, returns the unsafe lane to idle, restores pending state, emits `applied-patch`, then starts any queued history navigation.
- An unsafe malformed, failed or post-preflight application result marks the form uncertain and keeps the global unsafe lock, restores pending state, emits its diagnostic and requests uncertainty feedback, then emits `uncertain-unsafe-result`. Queued navigation remains blocked.

Failure statuses are included only when the received status is accepted by version 1; failures never claim targets. The URL is the received response URL when there was a response, otherwise the attempted URL. Settlements contain no HTML, values or thrown errors.

`bindTransportFeedback(root)` binds one host-authored `data-graft-feedback` container with one each of `data-graft-feedback-safe`, `data-graft-feedback-uncertain`, `data-graft-feedback-dismiss` and `data-graft-feedback-reload`. It supplies `TransportFeedback` and cleanup without injecting copy or presentation:

```html
<div data-graft-feedback hidden>
    <p data-graft-feedback-safe role="status">The request failed. Try again.</p>
    <p data-graft-feedback-uncertain role="alert" hidden>
        The result is uncertain. Reload before continuing.
    </p>
    <button type="button" data-graft-feedback-dismiss>Dismiss</button>
    <button type="button" data-graft-feedback-reload hidden>Reload</button>
</div>
```

Safe feedback may be dismissed without changing transport state. Uncertainty takes precedence, cannot be dismissed, and owns reload behaviour. Missing or ambiguous slots produce a diagnostic and a no-op binding rather than an application-startup failure.

Safe failures are tracked by source form, not by a request lane: a successful retry clears only its form, one successful form cannot hide another form's failure, disconnected forms are pruned, and a successful page navigation clears page-local failures.

`hypergraft:diagnostic` is a typed, secret-safe fact emitted before fallback or feedback. Its closed reasons cover transport, redirect, byte limit, UTF-8, protocol, target/content and patch-application failures, plus invalid live-form, unknown-island and feedback configuration. Request diagnostics are bounded to request classification, URL, originating element and, where already validated, target identifier; configuration diagnostics carry only their closed, relevant element or island-name facts. Diagnostics never expose response bodies, form values, server diagnostics or arbitrary exceptions. Hosts may listen in development; production logging and presentation remain host policy.

## Islands

`observeIslands` scans host-authored `data-island` roots and does not add binding attributes. An initialiser can return an `IslandInstance`, a cleanup callback, or `void`; the latter two are normalised internally. A simple binding can therefore return cleanup directly: `root => { root.addEventListener("click", handler); return () => root.removeEventListener("click", handler); }`. Mount, reconciliation and destruction failures are isolated per island. Connected roots mount once. Applied patches scan their targets before reconciliation. Location changes scan the document before reconciliation. A retained node that gains `data-island` through morph is therefore mounted. Moved roots are preserved and disconnected roots are cleaned up.

An instance that needs lifecycle facts implements `reconcile(context)`. The context is a discriminated union:

```ts
import type {
    IslandInstance,
    IslandReconcileContext,
} from "hypergraft/browser/islands";

const initialise = (root: HTMLElement): IslandInstance => ({
    reconcile(context: IslandReconcileContext) {
        if (
            context.cause === "patch" &&
            context.detail.outcome === "applied-patch"
        ) {
            // Re-read server-authored attributes after pending state is final.
        }
    },
    destroy() {},
});
```

`{ cause: "patch", detail: RequestSettledDetail }` describes a settled form request, including safe failure and unsafe uncertainty without invented targets. `{ cause: "location", detail: LocationChangeDetail }` describes a completed enhanced location change. Islands may use applied target identifiers to narrow work, but must treat server-rendered attributes as authoritative and reapply CSSOM-only presentation after reconciliation when needed.

## Copyable host patterns

These examples deliberately leave layout, copy, authentication and domain work with the host.

### Page navigation as a titled `main` patch

```html
<a href="/items" data-graft>Items</a>
<main id="main"><!-- server-rendered page content --></main>
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

### Canonical GET form with one targeted projection

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

A live GET form can submit on `input` or `change` without a click. Mark the control with `data-graft-submit-on="input"` or `data-graft-submit-on="change"`. Optional `data-graft-debounce` is a whole number of milliseconds from 0 to 2000; omit it for an immediate submit. Optional `data-graft-submit-with` names the submitter that must belong to the same form. Live enhancement is GET-only, `application/x-www-form-urlencoded`, same-origin and fragment-free. Anything else stays native and emits `invalid-live-form`.

```html
<form method="get" action="/items" data-graft>
    <label
        >Search
        <input
            name="q"
            type="search"
            data-graft-submit-on="input"
            data-graft-debounce="200"
    /></label>
    <button id="item-search" type="submit">Search</button>
</form>
```

### Command rejection and negotiated success redirect

```html
<form method="post" action="/settings" data-graft>
    <label>Value <input name="value" required /></label>
    <button type="submit">Save</button>
</form>
<section id="settings-form"><!-- server-rendered form fragment --></section>
```

```rust
use axum::{extract::Form, response::Response};
use hypergraft::{outcome, CommandGraft, PatchStatus};

async fn save_settings(
    graft: CommandGraft,
    Form(form): Form<SettingsForm>,
) -> Result<Response, HostError> {
    let rejected = form.validate();
    if let Err(errors) = rejected {
        let fragment = SettingsFragment { errors };
        return match graft {
            CommandGraft::Document => render_document("Settings", &fragment),
            CommandGraft::Patch => Ok(outcome::children_patch(
                PatchStatus::UnprocessableEntity,
                "settings-form",
                &fragment,
            )?),
        };
    }
    persist_settings(form).await?;
    Ok(outcome::redirect(graft, "/settings")?)
}
```

### Streamed command with progress frames

A long command can send `Graft-Transfer: stream` instead. Each frame is one length-prefixed envelope. Progress frames apply while the form stays pending. The last frame settles the request.

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

Native document fallback waits for the finished page. Do not stream a document response.

### Transient island proposing through a real form

```html
<form id="position-form" method="post" action="/positions" data-graft>
    <input name="position" type="hidden" />
    <button type="submit">Apply</button>
</form>
<div data-island="position-preview" data-position="0">
    <button type="button" data-propose-position="1">Preview position</button>
    <output data-position-output>0</output>
</div>
```

```ts
import type { IslandInstance } from "hypergraft/browser/islands";

export function initPositionPreview(root: HTMLElement): IslandInstance {
    const form = document.querySelector<HTMLFormElement>("#position-form")!;
    const input = form.elements.namedItem("position") as HTMLInputElement;
    const button = root.querySelector<HTMLButtonElement>(
        "[data-propose-position]",
    )!;
    const output = root.querySelector<HTMLOutputElement>(
        "[data-position-output]",
    )!;
    const onPropose = () => {
        input.value = button.dataset.proposePosition!;
        output.value = input.value; // Transient preview only.
        form.requestSubmit(); // The form's Apply button remains the fallback.
    };
    const reconcilePreview = () => {
        output.value = root.dataset.position ?? "0";
    };
    button.addEventListener("click", onPropose);
    reconcilePreview();
    return {
        reconcile(context) {
            if (context.cause !== "patch" || context.detail.form !== form)
                return;
            // Re-read the authoritative server-rendered value after settlement.
            reconcilePreview();
        },
        destroy() {
            button.removeEventListener("click", onPropose);
        },
    };
}
```

Register this initialiser with `observeIslands({ "position-preview": initPositionPreview })`. The gesture preview is client-owned only until the request settles; reconciliation re-reads the server-rendered root rather than inferring completion from DOM changes.

## Browser setup

```ts
import {
    bindTransportFeedback,
    listenForDiagnostics,
    startHypergraft,
} from "hypergraft/browser";
import { observeIslands } from "hypergraft/browser/islands";

const stopDiagnostics = import.meta.env.DEV
    ? listenForDiagnostics((detail) =>
          console.warn("Hypergraft diagnostic", detail),
      )
    : () => {};
const bound = bindTransportFeedback(document.body);
const stopTransport = startHypergraft({ feedback: bound.feedback });
const stopIslands = observeIslands({});

export function stopHostIntegration(): void {
    stopIslands();
    stopTransport();
    bound.destroy();
    stopDiagnostics();
}
```

The host must provide trusted server rendering, authentication, authorisation, unsafe-method Origin checks, a nonce-compatible Content Security Policy and product-owned feedback markup. The Trusted Types policy is exported as `TRUSTED_TYPES_POLICY_NAME`; effective CSP compatibility remains an integration-test responsibility.

## Development setup

Hypergraft uses mise to pin Rust, Node.js and pnpm. Playwright uses its managed Chromium installation by default.

Prepare a fresh clone:

```sh
mise install
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

`BROWSER_EXECUTABLE_PATH` selects another Chromium-compatible executable when the variable is present.

On Linux, this command also installs required system packages when the host grants system access:

```sh
pnpm exec playwright install --with-deps chromium
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you propose a change. Report security issues through [SECURITY.md](SECURITY.md).

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

## Tests and layout

Run format and static checks:

```sh
mise run clean
```

Run all test suites:

```sh
mise run test
```

Run one test suite when you need a narrower result:

- `cargo test --all-features`
- `pnpm test`
- `pnpm test:browser`

Rust integration is in `src/`. The runtime is in `browser/`. `protocol-v1.json` is the shared conformance fixture.
