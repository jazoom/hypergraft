# Contributions

Hypergraft is an unpublished source preview. Protocol version 1 remains narrow and uses `protocol-v1.json` as its canonical fixture.

## Before a change

- Read the [front page](README.md) and the [anonymous task list](examples/reference/README.md).
- Read [Protocol version 1](docs/protocol-v1.md) before any change to wire behaviour.
- Read [Host integration](docs/host-integration.md) and [Browser runtime](docs/browser-runtime.md) for public APIs.
- Read [Live](docs/live.md) and [Security](docs/security.md) when the change touches sockets or CSP.
- Open an issue before any change to protocol behaviour.
- Keep real links, forms and canonical GET documents.
- Keep the server authoritative. JavaScript is required for live projections and command patches.
- Do not add another Rust host adapter without an accepted plan.

## Development setup

Install the pinned tools and dependencies:

```sh
mise install
pnpm install --frozen-lockfile
```

Run the anonymous example:

```sh
mise run example
```

Open `http://127.0.0.1:3000/tasks`.

That launch does not install Playwright browsers.

If you run the focused browser contracts, install Playwright Chromium:

```sh
pnpm exec playwright install chromium
```

Set `HYPERGRAFT_BROWSER` to `firefox` or `webkit` to run that engine. Install that Playwright browser first. Set `BROWSER_EXECUTABLE_PATH` only for Chromium. Read [Compatibility](docs/compatibility.md) for the tested engine matrix.

## Quality requirements

Run format and static checks:

```sh
mise run clean
```

Run all test suites:

```sh
mise run test
```

Add a test only when it protects an invariant that the compiler cannot enforce.

Focus tests on these contracts:

- Test request classification, envelope bounds and the browser state machine.
- Test lock-step behaviour with `protocol-v1.json`.
- Test island registry behaviour that Hypergraft owns.

Do not add host product tests or tests that restate a trivial map or match.

## Pull requests

- Keep each pull request narrow.
- Explain the protocol or security effect.
- Update documentation when a public contract changes.
- Include test results in the pull request description.
- Report security defects through `SECURITY.md`.
