# Agent integration guide

This is the short reference for agents that build host applications with Hypergraft.

## Mental model

- The server owns application state and renders authoritative HTML.
- HTTP serves a full document at each canonical GET URL. Deep links and reloads still work.
- Real links and forms describe requests. JavaScript is required for command patches and live projections.
- Hypergraft owns request classification and bounded response envelopes. It also owns one live socket per document.
- Hypergraft is not htmx. The server selects patch targets and operations, not client attributes.

## Connect a host

For the example below, add these crates.io dependencies to the host crate's `Cargo.toml`:

```toml
[dependencies]
hypergraft = "0.1.0"
askama = "0.16"
axum = "0.8"
serde = { version = "1", features = ["derive"] }
```

Add the browser package from npm to `dependencies` in the host's `package.json`:

```json
"hypergraft": "^0.1.0"
```

Use a TypeScript-capable bundler, such as Vite, for the browser package.

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

Keep page-local fragments in named Askama blocks within their page template.

Keep each retained target outside the block that supplies its children.

Use separate files for fragments with independent reuse across pages.

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
<section id="settings-form">
    {% block settings_form %}
    <form method="post" action="/settings" data-graft>
        <label>Value <input name="value" value="{{ value }}" required /></label>
        <p role="alert">{{ error }}</p>
        <button type="submit">Save</button>
    </form>
    {% endblock %}
</section>
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

#[derive(Template)]
#[template(path = "settings.html", block = "settings_form")]
struct SettingsForm {
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
                "settings-form",
                &SettingsForm {
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

`SettingsForm` selects the page-local `settings_form` block. It needs only fields referenced by that block, not unrelated page data. The rejection patch retains `settings-form` and excludes its wrapper from the payload.

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
    <p data-graft-feedback-blocked role="status" hidden>
        Another request is active. This command was not sent.
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

## Automatic required behaviour

Vite hosts can configure `islandModules({ roots })` from `hypergraft/vite`, import `islands` from `virtual:hypergraft/islands`, and pass it to `startHypergraft`. Declare a literal typed `islands` object in each `browser.ts`, using normal static imports. Omitted loading metadata means required dependency loading; `export const islandLoading = "eager"` protects independently available shell or safety behaviour. Direct stylesheet imports remain eager. Do not duplicate discovery with a host glob/watch list.

Render exactly one `data-graft-workspace` boundary initially `inert` and `aria-busy="true"`, with shared status and an ordinary reload link outside it. Required initialisers must throw after cleanup on failed setup; returning normally claims successful mounting. Complete page navigation applies validated HTML and commits its URL immediately, then loads required modules behind the gate. Failure stays on the new page with native reload recovery. Targeted updates, commands and streams still load before application and recheck targets after waiting. Internal reconciliation finishes before public completion and scroll restoration. Commands are never replayed. Read [Required island modules](required-islands.md) for markup, failure handling, live snapshots, watch support and compatibility.

## Manual co-located browser behaviour

Keep feature TypeScript and its tests beside the feature's server code and templates. A `browser.ts` module exports `islands`: either an `IslandRegistry` map or a synchronous factory from typed host services to that map. Keep root state inside initialisers, not module imports or registration factories.

`collectIslands(modules, services)` combines those exports before `startHypergraft({ islands })`. Omit `services` when no factory requires it. Duplicate names and malformed module exports fail at registration. Vite hosts can discover `**/browser.ts` with eager `import.meta.glob<IslandModule<BrowserServices>>`; other hosts can pass explicit module imports. No protocol change is required. Vite's build-watch mode can use `watchIslandModules` from the optional `hypergraft/vite` entry to discover added, removed or renamed feature modules without a restart. Configure the glob importer and its source roots once; Vite's development server already handles these changes.

**For manual registries, keep islands eager by default.** Defer only a substantial optional implementation with a measured loading or startup benefit that outweighs extra requests, delayed interaction, layout changes, failure handling and tests. Small clipboard helpers and simple form controls rarely qualify. Being safe to load later does not itself justify doing so. Inspect generated chunks for accidental eager imports and measure the user-facing benefit, not just the entry chunk size.

Eager initialisers remain synchronous. For a justified lazy candidate, use `preview: lazyIsland(() => import("./preview").then((module) => module.initPreview))`. Keep registration eager: the loader resolves to a synchronous initialiser, not a module or registry. Type mixed maps as `IslandRegistry<IslandDefinition>` and typed glob modules as `IslandModule<BrowserServices, IslandDefinition>`; the existing default types remain eager-only. No Vite plugin is needed. Runtime loads and successful code are shared per definition; state and mount signals are separate per root. Ended roots and runtimes ignore late results. Stopping also ends active scans and skips loaders that have not started. Mount uses current DOM and does not replay earlier reconciliation facts.

Import completion means code is available, not that a root has mounted. Successful initialisation is per root and does not prove that further host-owned work is ready. Wait for the specific behaviour required by a test or feature; initialisers still must not return promises.

`startHypergraft({ islands, onIslandError })` forwards island failures to the host instead of the default console reporter. Standalone `observeIslands(islands, reporter)` accepts the same `IslandErrorReporter(name, phase, error, root)` callback. The phase is `"mount"`, `"reconcile"` or `"destroy"`; the root identifies the exact affected element, including when names or IDs are shared across lifetimes. Existing three-argument callbacks can ignore the fourth argument. Callbacks must not throw. They can run before `startHypergraft` returns or during teardown, and destruction can report a detached or renamed root. Exception details and DOM contents are not secret-safe telemetry; show generic user-facing messages instead.

Lazy loading does not disable controls, delay transport or replay gestures. Keep consent, required draft/settings restoration and coordinated submission behaviour eager, or explicitly own a safe server-rendered disabled state and independent recovery path. Load failures use the existing `"mount"` error-reporting phase. Failed roots do not retry on reconciliation. The existing callable cleanup handles from `startHypergraft` and `observeIslands` also expose `retryIsland(root)`: it schedules a retry for a current failed lazy root without replacing DOM, returning `true` for acceptance, not readiness. Repeated calls while loading and calls on stopped or replaced handles return `false`. A new root lifetime can also retry; there is no automatic retry loop. Read [Optional lazy islands](browser-runtime.md#optional-lazy-islands) before choosing a readiness or retry policy.

Thin `browser.ts` modules for registration and wiring are allowed. Keep distinct behaviours in focused sibling modules, with tests beside their implementations; choose boundaries by responsibility, not current file size. A single focused implementation can stay in `browser.ts`. Keep feature tests local rather than mounting unrelated features through a shared application test setup.

Hypergraft still owns mounting, reconciliation delivery and lifetime cancellation. Hosts still own record identity, draft memory and coordination within each feature. Required modules use the runtime's documented mounting and reconciliation order. A retained root does not guarantee a retained record identity. Never execute scripts from patched templates.

Read [Co-located island modules](browser-runtime.md#co-located-island-modules) for the complete recipe and configuration requirements.

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
- A batch contains 1–16 patches and at most 67108864 envelope bytes. Browser limits are 1000000 inserted nodes and nesting depth 64.
- Deploy the Rust crate and browser bundle from the same fixture revision. Older bundles retain the smaller content budgets.
- Patches cannot contain script elements.
- A title updates `document.title`, not the document head.
- Optional `scrollRestoration: true` restores window and registered container positions after fresh history responses. Logical anchors take precedence over old offsets.
- Safe GET work is cancellable. An uncertain command keeps the document's unsafe lock and suspends live work until a reload.
- Server-authored form state wins after a patch. A retained DOM node does not prove request completion.
- A blocked command emits `command-blocked`, not settlement. The runtime never queues or replays that command.
- `commandBlockReason()` exposes the current guard for host coordination. A host must revalidate its own deferred actions before submission.
- Optional `data-graft-feedback-blocked` content explains that a command was not sent. Uncertainty still requires reload feedback.

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

## Optional intent prefetch

`startHypergraft({ prefetch })` selects an intent policy for enhanced links. The option defaults to off.

- `true`, `{}` or `{ links: "marked" }` requires per-link `data-graft-prefetch` opt-in.
- `{ routes: ["/items", "/diary"] }` enables all enhanced links to exact approved pathnames.
- `{ links: "all" }` enables all otherwise eligible enhanced links.

`data-graft-prefetch="false"` excludes individual links in every mode. An opt-in attribute cannot extend a route list. Queries remain part of request identity. GET forms and native links never become speculative through these options.

Server approval uses `outcome::prefetchable_page_patch` or `PatchSet::respond_prefetchable_navigation()`. Both emit `Graft-Prefetch: intent` without a change to `no-store`. Request-start eligibility remains a host responsibility. Server approval arrives too late to prevent an unwanted GET.

Every object option accepts `maxAgeMs`, with a default of 10,000 ms from request start, not completion. An age-only object requires marked links. Valid values are integers from 1 to 2,147,483,647 ms, inclusive. Invalid values throw `RangeError` at startup. The runtime snapshots the age alongside eligibility. The upper bound prevents browser timer overflow.

Activation consumes the entry once and removes its speculative deadline. Longer retention increases the interval between request-time authorisation and activation. The host owns approval for this interval. The runtime allows one speculative request and at most 524,288 decoded bytes.

A rolling ten-second window admits at most four speculative requests, independently of `maxAgeMs`. Cancellation and adoption do not refund admission. Explicit requests bypass admission and cancel unrelated speculation.

Commands and query requests discard speculation at startup. Current live projections and live disconnection also discard it. Terminal live loss disables speculation for the document. Hidden documents, page departure and teardown discard entries. `invalidatePrefetch()` covers other host-observed changes.

Private routes require an approved application-retention policy. Ordinary route review must establish that eligible GETs are safe without a later click; no separate per-route approval workflow is required. Exclude authentication actions, one-use-token URLs, side effects and unsuitable expensive requests before request startup.

Approved speculation parses bounded HTML with protocol validation and starts discovered required module imports. It never mounts speculative roots, runs host content validators or changes the visible page. Activation retains normal content validation and departure guards, reuses eligible HTML once and joins in-flight code without waiting to display the page. Started imports cannot be cancelled, but ended speculation cannot mount roots or announce readiness. Manual registries and optional lazy islands keep their existing behaviour.

The [full contract](browser-runtime.md#intent-prefetch) defines byte accounting and the authorisation interval.

## Optional entry effects

`startHypergraft({ enterEffects })` owns identity-aware entry effects for targeted patches. The host supplies named Web Animations definitions. Markup selects a definition through `data-graft-enter="name"` and a stable DOM `id`.

```ts
startHypergraft({
    enterEffects: {
        row: {
            keyframes: [{ opacity: 0.2 }, { opacity: 1 }],
            timing: { duration: 200 },
        },
    },
});
```

```html
<li id="task-42" data-graft-enter="row">Read the security notes</li>
```

A whole-batch ID comparison prevents replay after text updates or root replacement. Moves do not cause replay. Removal and reintroduction in a later batch count as a new entry. IDs must distinguish logical records across targeted updates.

Initial documents receive no entry effects. Enhanced navigation and history traversal also receive no entry effects. Targeted GET forms and command-driven canonical location replacements remain eligible. Effects never delay settlement or change command outcomes.

Reduced motion suppresses effects unless the definition supplies an explicit `reducedMotion` alternative. Preference changes cancel active effects. Runtime teardown cancels only runtime-owned effects.

`timing` accepts finite, non-negative `duration` and optional `delay`. An optional `easing` selects the timing curve. The sum of duration and delay must remain finite. One iteration and no fill keep default styles authoritative. Unsupported timing fields disable the definition.

Content must remain visible without animation. The host needs no message-ID tracker or submission snapshot. It also needs no animation settlement listener. The feature changes no version 1 wire fields.

The [entry-effect contract](browser-runtime.md#entry-effects) defines lifecycle order and failure diagnostics.

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
| Organise page-local fragments                          | [Page-local blocks](host-integration.md#page-local-blocks)                         |
| Add GET query patches or command location replacements | [Host integration](host-integration.md)                                            |
| Add live projections                                   | [Live GET recipe](host-integration.md#live-get-projection), then [Live](live.md)   |
| Add streamed progress                                  | [Streamed command recipe](host-integration.md#streamed-command-recipe)             |
| Add an island                                          | [Island recipe](browser-runtime.md#island-recipe)                                  |
| Co-locate feature TypeScript                           | [Co-located island modules](browser-runtime.md#co-located-island-modules)          |
| Use lifecycle events or diagnose uncertainty           | [Browser runtime](browser-runtime.md)                                              |
| Change CSP or investigate Trusted Types                | [Security](security.md)                                                            |
| Change Hypergraft itself                               | [`AGENTS.md`](../AGENTS.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md)            |
| Change wire behaviour                                  | [`protocol-v1.json`](../protocol-v1.json) and [Protocol version 1](protocol-v1.md) |
