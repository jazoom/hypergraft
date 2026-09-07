# Browser runtime

The browser entry is side-effect free. `startHypergraft` creates one runtime instance. It enhances marked same-origin links and supported forms. The returned stop function tears that instance down. A later `startHypergraft` call disposes the previous instance.

Hosts register `listenForLiveStateChanges` before `startHypergraft`. The runtime then emits the first live transport state.

```ts
import {
    bindTransportFeedback,
    listenForDiagnostics,
    listenForLiveStateChanges,
    startHypergraft,
} from "hypergraft/browser";

const stopDiagnostics = import.meta.env.DEV
    ? listenForDiagnostics((detail) =>
          console.warn("Hypergraft diagnostic", detail),
      )
    : () => {};
const stopLiveState = listenForLiveStateChanges((detail) => {
    // An open socket does not prove that every projection is current.
    if (import.meta.env.DEV) console.info("Hypergraft live state", detail);
});
const bound = bindTransportFeedback(document.body);
const stopRuntime = startHypergraft({
    feedback: bound.feedback,
    islands: {},
    liveEndpoint: "/_hypergraft/live",
});

export function stopHostIntegration(): void {
    stopRuntime();
    bound.destroy();
    stopLiveState();
    stopDiagnostics();
}
```

`startHypergraft` uses `/_hypergraft/live` unless `liveEndpoint` names another path.

The supported integration contains one bundled runtime copy. Read [Security](security.md) for Trusted Types and that copy boundary.

## Request lanes

Safe work is cancellable. Teardown invalidates and aborts in-flight safe navigation and form requests. It clears live-form timers. It restores pending state. It clears safe-failure feedback. A disposed safe response must not patch, emit lifecycle events or call old feedback options.

An in-flight or uncertain unsafe command is not cancellable as though it never happened. Teardown must not unlock the document-level unsafe guard. That guard is preserved across runtime replacement.

`children` retains its target and morphs preflighted nodes. Server-authored attributes and form properties win. `append` retains its target and adds preflighted nodes as last children. Compatible keyed descendants can stay or move within one target. No identity guarantee crosses targets. A retained node is not evidence that transport completed.

Same-origin `POST` forms with `application/x-www-form-urlencoded` or `multipart/form-data` are enhanced. Multipart commands send `FormData` without a manual `Content-Type` header. Invalid command forms emit `invalid-command-form` and do not submit natively.

### Blocked commands

The runtime never queues or replays an unsafe command automatically. A pending command or navigation blocks another command before transport starts.

A blocked command emits a `command-blocked` diagnostic with its form and a closed `blocked` reason. It emits no request settlement because no request started. The reasons are:

- `pending-command`
- `pending-navigation`, which includes queued history navigation
- `uncertain-command`

Pending work requests optional `TransportFeedback.commandBlocked()` feedback. Uncertainty requests reload feedback instead. `bindTransportFeedback` uses an optional `data-graft-feedback-blocked` slot for a dismissible explanation that the command was not sent.

`commandBlockReason()` returns the current reason, or `undefined` when the runtime permits a command. This snapshot does not reserve the command lane.

A host can use that snapshot before an automatic preference update. A host can coalesce its own unsent preference updates after a known settlement. The host owns validation and priority for any deferred user action. An uncertain command retains the document guard across runtime replacement.

A settlement listener can synchronously submit another command. Live work remains suspended until that command also reaches a known result.

## Pending form state

Temporary pending state is not the latest authoritative form state.

While a request is in flight, the runtime sets `aria-busy` on the form. It disables the submitter. Progress frames keep that transport presentation. Final cleanup uses the latest Morphlex snapshot for owned controls. That snapshot includes an explicit attribute removal.

A DOM comparison alone cannot distinguish an authored `disabled` attribute from the temporary overlay. Cleanup therefore consumes ownership during apply. It preserves an authored `disabled` value even when it equals the pending overlay. It respects server-authored removal of `disabled`. It respects changes to `aria-disabled` and `aria-busy`.

If no authoritative patch changed the control, failure restores the original state. After an incomplete stream, cleanup still respects the latest applied frame. It does not restore an obsolete snapshot.

Cleanup finishes before request settlement reaches host listeners. Retained submitters keep their identity. State does not transfer to an unrelated node.

## Settlement

Applied navigation focuses the first patched target when that target is programmatically focusable. It then scrolls the window to `(0, 0)`. Version 1 does not restore history scroll positions. After a children patch, the previous offset belongs to different content.

A streamed form request emits `hypergraft:progress` after each applied progress frame. It sets `data-graft-progress` on the form until pending state is restored. It emits `hypergraft:requestsettled` only after the final frame, a clean end of body, and final pending state.

A complete form request emits `hypergraft:requestsettled` only after pending and submitter state is final. `RequestSettledDetail` contains the originating form, the effective request URL, the patch kind and one bounded outcome:

- A safe applied patch applies the whole preflighted batch and updates that form's failure state. A submitted GET form reconciles history and emits its location fact. The runtime then restores pending state and emits `applied-patch` with an accepted status and authoritative target identifiers.
- A safe failure emits its diagnostic, records the failed source and requests safe feedback. It then restores pending state and emits `safe-failure`.
- A superseded or aborted safe request emits neither a settlement nor a diagnostic. A valid navigation envelope uses `location.assign` and emits no settlement because the document leaves.
- A known unsafe patch applies its batch and returns the unsafe lane to idle. If the batch carries `location`, the runtime replaces the current history entry and emits `hypergraft:locationchange`. A queued history traversal takes precedence and suppresses that replacement. The runtime then restores pending state, emits `applied-patch` and starts the queued history navigation.
- An unsafe malformed, failed or post-preflight application result marks the form uncertain and keeps the global unsafe lock. It restores pending state, emits its diagnostic, requests uncertainty feedback, then emits `uncertain-unsafe-result`. Queued navigation remains blocked.

Failure statuses are included only when the received status is accepted by version 1. Failures never claim targets. The URL is the received response URL when there was a response. Otherwise it is the attempted URL. Settlements contain no HTML, values or thrown errors.

Complete batch preflight does not promise rollback after an application-time exception. Read [Protocol version 1](protocol-v1.md) for wire limits and named rejection cases.

## Live transport state

`hypergraft:livestatechange` reports only transport state. Its closed state union contains:

- `idle`
- `connecting`
- `open`
- `reconnecting`
- `suspended`
- `stopped`

Only `reconnecting` includes `retryDelayMs`. That delay is between 1,000 and 30,000 milliseconds while a reconnect timer exists. The detail includes `close` only when a recognised close caused the transition. The event excludes payloads, raw close reasons, request URLs and form values.

`suspended` is an intentional pause during a command or navigation. `reconnecting` is a retryable disconnection. `stopped` is terminal.

An open socket does not prove that every projection is current. `hypergraft:livepatch` remains the evidence that a particular patch applied.

Runtime teardown emits `stopped` unless the transport already reports that state. Later socket events and repeated teardown do not emit another state.

Command and navigation startup suspend live work before safe-request cancellation releases retired forms. A replacement GET owns its form retirement. An older GET cannot restore that form. Known command results restore eligible forms and resume live work. Uncertain results leave live work suspended.

## Runtime replacement

The unsafe document guard remains authoritative across runtime replacement.

If `documentUnsafe.kind` is `pending` or `uncertain`, the replacement runtime suspends live work before its first live reconciliation. It emits `suspended` as its initial state. It does not emit `connecting` or `open` before the required document reload. Neither startup nor mutation observation can open a socket during that suspension.

A final stop reloads immediately when an unsafe command is still pending or uncertain. If an old command returns after replacement, the replacement reloads authoritative state. The disposed runtime cannot apply the response. A disposed command response does not resume the replacement runtime.

A disposed runtime never applies a patch, emits settlement or calls feedback. Late events from an old socket must not mutate the replacement document.

## Transport feedback

`bindTransportFeedback(root)` binds one host-authored `data-graft-feedback` container. The container needs one each of `data-graft-feedback-safe`, `data-graft-feedback-uncertain`, `data-graft-feedback-dismiss` and `data-graft-feedback-reload`. It supplies `TransportFeedback` and cleanup. It does not inject copy or presentation.

```html
<div data-graft-feedback hidden>
    <p data-graft-feedback-safe role="status">The request failed. Try again.</p>
    <p data-graft-feedback-uncertain role="alert" hidden>
        The result is uncertain. Reload before continuing.
    </p>
    <p data-graft-feedback-blocked role="status" hidden>
        Another request is active. This command was not sent.
    </p>
    <button type="button" data-graft-feedback-dismiss>Dismiss</button>
    <button type="button" data-graft-feedback-reload hidden>Reload</button>
</div>
```

Blocked feedback can be dismissed without a change to transport state. A missing blocked slot leaves the original feedback slots functional. The diagnostic still reports the blocked command.

Safe feedback can be dismissed without a change to transport state. Uncertainty takes precedence. It cannot be dismissed. It owns reload behaviour. Missing or ambiguous slots produce a diagnostic and a no-op binding. They do not fail application startup.

Safe failures are tracked by source form, not by a request lane. A successful retry clears only its form. One successful form cannot hide another form's failure. Disconnected forms are pruned. A successful page navigation clears page-local failures.

## Diagnostics

`hypergraft:diagnostic` is a typed, secret-safe fact. It is emitted before fallback or feedback. Closed reasons cover transport, redirect, byte limit, UTF-8, protocol, target and content, and patch-application failures. They also cover invalid live-form, invalid command-form, unknown-island and feedback configuration.

Request diagnostics are bounded to request classification, URL, originating element and, where already validated, target identifier. Configuration diagnostics carry only their closed element or island-name facts. Diagnostics never expose response bodies, form values, server diagnostics or arbitrary exceptions.

The request URL can contain sensitive query values. Host policy for diagnostic logs remains a host concern. Read [Live](live.md) for the server counterpart.

## Live GET gestures

A live GET form can submit on `input` or `change` without a click. The control uses `data-graft-submit-on="input"` or `data-graft-submit-on="change"`. Optional `data-graft-debounce` is a whole number of milliseconds from 0 to 2000. An omitted value submits at once. Optional `data-graft-submit-with` names the submitter that must belong to the same form.

Live enhancement is GET-only, `application/x-www-form-urlencoded`, same-origin and fragment-free. Anything else stays native and emits `invalid-live-form`.

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

The [anonymous task list](../examples/reference/README.md) does not use this gesture. Filter changes there use an ordinary submit.

## Islands

`observeIslands` scans host-authored `data-island` roots. It does not add binding attributes. An initialiser receives its root and an `IslandMountContext` with one lifetime `AbortSignal`. Hypergraft aborts the signal before destruction after removal, a name change or runtime teardown. Event listeners can use the signal and return `void`.

Other initialisers can return an `IslandInstance`, a cleanup callback or `void`. Mount, reconciliation and destruction failures are isolated per island. Connected roots mount once. Applied patches scan their targets before reconciliation. Location changes scan the document before reconciliation. A retained node that gains `data-island` through morph mounts after the patch. Moved roots keep their instances. Disconnected roots are cleaned up.

An instance that needs lifecycle facts implements `reconcile(context)`. `IslandReconcileContext` is a discriminated union exported from `hypergraft/browser/islands`. The [island recipe](#island-recipe) consumes it after form settlement.

`{ cause: "patch", detail: RequestSettledDetail }` describes a settled form request. That includes safe failure and unsafe uncertainty without invented targets. `{ cause: "live-patch", detail: AppliedLivePatchDetail }` describes an applied live patch. `{ cause: "location", detail: LocationChangeDetail }` describes a completed enhanced location change.

Islands can use applied target identifiers to narrow work. They must treat server-rendered attributes as authoritative. They must reapply CSSOM-only presentation after reconciliation when needed.

The reference application does not use islands. The next section is a separate recipe.

## Island recipe

A transient island can propose through a real form. The gesture preview is client-owned only until the request settles.

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
        output.value = input.value;
        form.requestSubmit();
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
            reconcilePreview();
        },
        destroy() {
            button.removeEventListener("click", onPropose);
        },
    };
}
```

Register this initialiser through the runtime's island registry:

```ts
startHypergraft({ islands: { "position-preview": initPositionPreview } });
```

Reconciliation re-reads the server-rendered root. It does not infer completion from DOM changes. Standalone integrations can instead use `observeIslands` and its returned cleanup function.
