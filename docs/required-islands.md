# Required island modules

Automatic islands are required behaviour, not optional enhancement. Complete page navigation applies validated HTML immediately, then loads required code while the new workspace stays gated. Other response paths prepare code before application. Hypergraft mounts current roots in document order and finishes synchronous reconciliation before public completion. The wire protocol, CSP, cache rules and server authority do not change.

## Vite integration

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { islandModules } from "hypergraft/vite";

export default defineConfig({
    plugins: [...islandModules({ roots: ["src/features"] })],
});
```

```ts
// src/main.ts
import { startHypergraft } from "hypergraft/browser";
import { islands } from "virtual:hypergraft/islands";

const stop = startHypergraft({ islands });
```

Include `/// <reference types="hypergraft/vite/client" />` in the host's TypeScript declarations. Keep `browser.ts` modules under the configured roots:

```ts
import type { IslandRegistry } from "hypergraft/browser";
import { initEditor } from "./editor";
import "./editor.css";

export const islands = {
    editor: initEditor,
} satisfies IslandRegistry;
```

An omitted loading declaration means required, dependency-loaded behaviour. Independent shell and safety behaviour can declare `export const islandLoading = "eager";`. Those modules use static imports and their connected roots mount without waiting for page modules. Each eager exception needs an independent-operation or timing reason.

Discovery parses TypeScript without evaluating it. Registries must be exported literal objects with non-empty, unique literal names. `satisfies` and type assertions around the object are supported. Computed keys, spreads, accessors, factories and re-exported registries are rejected with source paths. `islandLoading` must be the literal `"eager"` or absent. Runtime export validation checks the loaded names, initialisers and loading declaration again. Unknown names fail closed.

One module supplies all of its names through one shared load. Vite owns dependency resolution, base URLs, hashed output and shared chunks; there is no forced chunk per root or size-based grouping. Imports must be free of mounting side effects. The browser may finish evaluating an import after every interested root has gone.

The plugin imports direct side-effect stylesheet imports from every registration into the eager entry, in sorted discovery and source order. Required geometry and disabled, draft and save presentation must not live only in a dynamically imported implementation. CSS modules, stylesheet query imports and hidden transitive stylesheet ownership need an explicit host design; the plugin does not execute or crawl arbitrary implementations to infer CSS. Preserve separate stylesheet entries where the host needs them. Inspect the emitted manifest and graph, not just source imports.

Roots are configured once. Do not combine `islandModules` with a host discovery glob or a second `watchIslandModules` plugin. Development refreshes the virtual entry on registration changes. Build watch uses the existing directory watcher and a private generated entry to notice additions, removals, renames and declaration edits. Temporary entries and watchers are cleaned up. Directory links are not followed.

`defineIslandModules` supplies the typed runtime registry used by the generator. Manual integrations can continue using ordinary `IslandRegistry` values, `collectIslands`, standalone `observeIslands` and optional `lazyIsland`. They do not acquire required readiness semantics merely because their names match automatic modules.

## One workspace boundary

Automatic mode requires exactly one connected workspace marker per document, including documents with no current islands. Missing or duplicate markers fail closed. Keep shell navigation, safety controls and recovery outside it:

```html
<aside data-graft-workspace-feedback>
    <p data-graft-workspace-loading role="status">Preparing the workspace.</p>
    <p data-graft-workspace-failure role="alert" hidden>
        This workspace could not be prepared. Reload before continuing.
    </p>
    <p>Reloading will discard unsaved changes.</p>
    <a href="">Reload page</a>
</aside>
<noscript>JavaScript is required to use this workspace.</noscript>
<main id="main" data-graft-workspace inert aria-busy="true">
    <!-- Server-rendered content -->
</main>
```

The ordinary reload link works even if the bootstrap never starts. Do not depend solely on a runtime-bound button or a `noscript` explanation: JavaScript can be enabled but fail to load. Keep feedback outside both the workspace and its patch targets, and style it in the host's initial CSS.

The marker assigns the workspace's initial `inert` and `aria-busy` gate to Hypergraft. Do not share those same attributes on that same element with another owner. Authored descendant locks, disabled controls, read-only state and ancestor locks remain untouched; an alarm can keep an ancestor inert independently.

Initial dependencies include connected roots throughout the document, even hidden roots outside the workspace. Native template contents are inactive until inserted. Do not put independently interactive shell behaviour in a cold module outside the boundary. A successful import is not readiness: all current required roots must mount successfully before interaction resumes. Mounts are synchronous, parent before child, rather than network-completion order. Additional asynchronous feature work remains feature-owned.

The runtime guards form submission before payload construction, including Enter, external form-associated controls, `requestSubmit()` and declarative submission. A client-inserted required root cannot submit in the turn before mutation observation. Blocked gestures are discarded, never queued or replayed. Independent shell forms retain the existing document command and navigation locks. Workspace readiness adds no global command lock.

A required initialiser must throw when required setup fails. Returning a no-op instance or setting a feature failure attribute is a successful return, not a failure report. Tie listeners to the mount signal, and clean up partial resources that the signal does not own before throwing. A failed required reconciliation aborts and destroys that instance. Initial-document failures retain the gate and show generic recovery without exception text or automatic retries.

## Responses and lifecycle

All response paths use the same module resolver. Complete responses first undergo bounded preflight, including host validation. Module loading never mounts detached content. Navigation departure guards run immediately before commitment.

For a complete GET page navigation, Hypergraft applies the validated batch and commits history and the URL immediately. It keeps the new workspace inert, displays shared loading feedback, and loads the modules needed by current connected roots. Eager shell behaviour remains independent. Only after mounting and reconciliation does it release readiness, emit the completed location fact, restore focus/scroll and report navigation success. A URL change alone does not mean the workspace is usable.

Targeted GETs, commands and streams still load before application. A patch that touches the workspace prepares both incoming roots and current roots that survive the patch, including those still loading from the initial document. Roots removed by the patch do not block it. After the wait, the runtime checks request ownership, target identity, overlap, source bounds and final document identifiers again, without repeating host validation callbacks.

New current roots mount after application. Required retained roots reconcile only after authoritative pending-state cleanup. If mounting or reconciliation inserts another required root, the owning request keeps its gate and waits for that root to load and mount before public completion. New roots mount from the current document without replaying lifecycle facts to retained instances. Cancellation also retires these waits. Internal island lifecycle work precedes public completion listeners and history scroll restoration. Standalone observers still consume public lifecycle events; runtime-owned observers receive those facts directly, once per fact. Manual island errors remain isolated.

Keep initialisers and reconciliation synchronous. An island that proposes a new command after reconciliation should schedule its own new work after returning, for example in a lifetime-checked microtask. It must not replay a command that the runtime already blocked. An autosave owner can coalesce unsent edits after a known save result; that remains application behaviour.

A transport failure before link commitment leaves the old page, values and history intact, with explicit retry. Invalid responses and failed/cancelled history traversal before commitment still use authoritative document recovery. After complete navigation commits, a module, mounting or reconciliation failure stays on the new page and URL, keeps its workspace gated and shows the shared reload recovery. It does not automatically reload or attempt arbitrary rollback. Browser import failures can remain cached; a native reload creates a fresh document.

Cancellation after complete commitment ends the wait and shows recovery on the new page; it does not undo history. Another supported navigation can leave that page. Supersession retires the old wait before fetching the next page. Runtime replacement initialises the current committed document rather than reloading the old URL. Late imports cannot mount or settle the retired navigation. Scroll snapshots belong to the committed history entry even before readiness.

A targeted GET does not apply incomplete content. A POST never retries because its response needs unavailable code; uncertainty retains the unsafe lock and requires authoritative reload. Post-application failure keeps the workspace gated.

Streams prepare one frame at a time and stop reading/application at a cold frame. Progress may appear, but the changed workspace stays gated until final authoritative reconciliation and clean settlement. Partial failure or cancellation does not release that gate. Existing frame and byte budgets remain unchanged.

Cancellation and runtime replacement retire dependency waits immediately. Imports themselves cannot be cancelled. Late completion may populate the browser's module cache but cannot mount, patch, report failure or announce readiness for an ended operation.

Intent prefetch parses approved, bounded HTML with protocol validation and starts its discovered required module loads. It never mounts speculative roots, changes readiness or runs host content callbacks. Activation still performs full validation against the current document and shares in-flight or available code without delaying visible commitment. Module failure during speculation is silent until the code is needed. HTML retention and admission bounds remain unchanged; imports already started cannot be cancelled and may remain in the browser module cache. Manual registries and optional `lazyIsland` do not gain speculative loaders.

## Live recovery

A cold live response does not block the socket. Hypergraft retires only the affected subscription, discards its response, and shares the ordinary module load. This also covers retained workspace roots still loading from the initial document. Independent subscriptions and terminal identity loss stay responsive. A still-current form gets a fresh subscription identity after loading; retired identities remain ignored.

If live reconciliation inserts a new required root after application, the changed workspace stays gated while it loads and mounts. The affected subscription retires without announcing that frame as complete, then requires the same fresh covering snapshot. Independent subscriptions remain responsive during this wait.

A command or query can interrupt that dependency wait without clearing the retained form's snapshot requirement. Resumed responses prepare any still-cold modules again. Unrelated requests do not reset failed live recovery.

The Rust live owner performs a fresh guarded refresh on subscription, but version 1 also permits `append`. Resubscription alone therefore cannot prove a full snapshot. After cold loading, the browser requires a `children` snapshot covering every previously observed or discarded target. If the response does not cover those targets, or recovery fails validation, target ownership, loading or island setup, that projection remains unavailable and does not resubscribe in a loop. Hosts using incremental projections must recover with an authoritative document instead. No wire field or operation is added or removed.

Render optional independent recovery for this state:

```html
<aside data-graft-workspace-live-failure hidden>
    <p role="alert">
        Some live updates are unavailable. Information may be out of date.
    </p>
    <p>Reloading will discard unsaved changes.</p>
    <a href="">Reload page</a>
</aside>
```

Continue using ordinary live projection freshness feedback. An open socket never establishes that every projection is current.
