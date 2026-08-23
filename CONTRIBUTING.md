# Contributions

Hypergraft is an unpublished source preview. Protocol version 1 remains narrow and uses `protocol-v1.json` as its canonical fixture.

## Before a change

- Read the design goals and protocol bounds in `README.md`.
- Open an issue before any change to protocol behaviour.
- Keep native HTML fallbacks.
- Keep the server authoritative.
- Do not add another Rust host adapter without an accepted plan.

## Development setup

Install the pinned tools and dependencies:

```sh
mise install
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Set `BROWSER_EXECUTABLE_PATH` only when you need another Chromium-compatible executable.

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
