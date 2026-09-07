# Compatibility

Hypergraft is a source preview.
The source-preview Rust API and browser API remain experimental.
Those APIs can change without a new protocol version.

Protocol version 1 is the versioned wire contract.
An incompatible wire change requires a new protocol version.
[`protocol-v1.json`](../protocol-v1.json) is the canonical fixture.
Read [Protocol version 1](protocol-v1.md) for the wire rules.

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
