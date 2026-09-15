# Compatibility

Hypergraft is a source preview.
The source-preview Rust API and browser API remain experimental.
Those APIs can change without a new protocol version.

Protocol version 1 is the versioned wire contract.
An incompatible wire change requires a new protocol version.
[`protocol-v1.json`](../protocol-v1.json) is the canonical fixture.
Read [Protocol version 1](protocol-v1.md) for the wire rules.

## Template identity migration

[Template language](template-language.md) and [Template identity](template-identity.md) define the approved replacement contract from [NEXT.md](../NEXT.md).

Identity metadata stays inside HTML content. This plan changes no wire version, envelope operation or existing resource limit. It adds a bounded interpretation of `data-graft-key` within the coordinated source-preview compiler/runtime pair.

This decision does not claim transparent mixed-runtime compatibility. Older runtimes do not enforce the marker contract. Morphlex does not implement the specified sibling-local correspondence. Previously accepted arbitrary marker values can fail the new validator.

Browser preflight now enforces the canonical fixture's reconciliation metadata rules. Automatic compiler annotations enter production only after that validation boundary. Compiler and browser releases must use the same fixture revision.

Deployment must replace cached browser bundles with the matching runtime before annotated output becomes active. Open documents also need a reload into that matched deployment. A cache update alone does not replace an active runtime.

Existing authored markers must satisfy the new encoding before key validation becomes active. Current-subtree validation also rejects invalid markers in contents that a patch replaces. Such documents need a full reload with valid markup, not a repair patch.

The owned reconciler replaces Morphlex. Unkeyed correspondence now uses sibling-local ordinals, including whitespace text and comments. It never searches for similar descendants.

An incompatible ancestor ends descendant identity. Different effective input types require replacement. Authoritative snapshots supersede dirty control properties, even when attributes remain equal.

Native moves preserve platform state when applicable. Fallback moves retain object identity but can trigger custom-element connection callbacks.

If implementation reveals a wire incompatibility beyond this coordinated metadata contract, dependent work must stop until explicit approval of a protocol version change.

## Tested engines

Continuous integration runs the focused browser contracts on these Playwright engines:

- Chromium
- Firefox
- WebKit

The same jobs run the real-CSP fixtures.

The suite uses Playwright's bundled WebKit build.
That result is not a promise about every Safari release.
It is not a promise about every mobile WebKit build.

## Trusted Types

Chromium enforces Trusted Types in the CSP fixtures.
Firefox and Playwright WebKit do not implement Trusted Types.

Tests apply Trusted Types assertions only when `window.trustedTypes` exists.
Every engine still receives the CSP fixtures and the lifecycle assertions.

## Browser installation

If you run the local Chromium suite, install Playwright Chromium.

```sh
pnpm exec playwright install chromium
```

If you run Firefox or WebKit, install that Playwright browser first.

```sh
pnpm exec playwright install firefox
pnpm exec playwright install webkit
```

Set `HYPERGRAFT_BROWSER` to `chromium`, `firefox` or `webkit`.
Use `chromium` when the variable is absent.

```sh
HYPERGRAFT_BROWSER=firefox pnpm test:browser
```

If you need another Chromium executable, set `BROWSER_EXECUTABLE_PATH`.
Do not set `BROWSER_EXECUTABLE_PATH` for Firefox or WebKit.

If you are on Linux and the host grants system access, install browser dependencies.

```sh
pnpm exec playwright install --with-deps chromium
```
