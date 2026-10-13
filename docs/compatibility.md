# Compatibility

Hypergraft is a source preview.
The source-preview Rust API and browser API remain experimental.
Those APIs can change without a new protocol version.

Protocol version 1 is the versioned wire contract.
An incompatible wire change requires a new protocol version.
[`protocol-v1.json`](../protocol-v1.json) is the canonical fixture.
Read [Protocol version 1](protocol-v1.md) for the wire rules.

## Child reconciliation

Hypergraft uses Askama and its own private browser child reconciler. Morphlex is no longer a dependency. The [child reconciler decision](child-reconciler.md) records the matching contract, correctness checks and performance comparison.

The wire format, Askama output and public browser API are unchanged. There are no generated reconciliation markers. The earlier [template engine rollback](template-engine-decision.md) remains historical evidence, not a plan to replace Askama.

Stable IDs retain compatible siblings. Unkeyed elements can now be replaced where Morphlex fell back to a tag match across changed `name`, `href` or `src` hints. Adding or removing an ID also replaces an element. Hosts that depend on control or island identity should provide stable IDs. Neither moving between parents nor moving between patch targets promises retention.

Server-authoritative updates now remove every obsolete attribute, update retained template contents and reset dirty control properties even when markup is unchanged. File inputs inside a `children` patch are cleared. Named form controls no longer interfere with the reconciler's DOM operations.

Deploy the new browser bundle, invalidate cached assets and reload open documents so their matching and control-state behaviour is consistent. No server template migration or protocol version change is needed.

Empty incoming ID attributes still fail the existing ID syntax rule. The canonical fixture covers all browser preflight entry points.

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
