# Contributions

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
- Test preflight callbacks, form-property access, pending ownership and focus through focused browser contracts.

Do not add host product tests or tests that restate a trivial map or match.

## Releases

`mise run release` publishes the Rust crate and npm package with the same version. It leaves protocol version 1 unchanged.

The release task requires:

- A clean working tree on `main`, with all intended changes committed.
- The `origin` remote for `jazoom/hypergraft`, with permission to push `main` and tags.
- A GitHub account with access to CI and permission to create releases.
- npm and crates.io credentials with permission to publish `hypergraft`.
- The development tools and Playwright Chromium from the development setup above.

### Prepare a release

Install GitHub CLI before the first release.

Preview the next version:

```sh
mise run release -- patch --dry-run
mise run release -- minor --dry-run
mise run release -- major --dry-run
```

Start the release with the required version increment:

```sh
mise run release -- patch
```

At each release confirmation prompt, enter the proposed version to continue.

### Release behaviour

The preview makes no changes and requires no network access. It does not test credentials, remote version availability or package contents.

The task starts an interactive login when a service reports absent or invalid credentials:

- `gh auth status` starts `gh auth login --hostname github.com`.
- `npm whoami` starts `npm login`.
- Cargo publication starts `cargo login`.

Each command retries once after login. Login requires an interactive terminal. Other failures stop the release.

A real release rejects mismatched package versions and existing release versions or tags. The first release confirmation precedes version changes and the push to `main`.

The task updates `Cargo.toml`, `Cargo.lock` and `package.json`. It then runs:

- Dependency installation with the frozen lockfile.
- `mise run clean` and `mise run test`.
- The reference application builds.
- The package publication dry runs.

The task commits the version changes and pushes `main`. It waits up to 60 minutes for successful CI on that exact commit. CI includes Chromium, Firefox and WebKit.

The second prompt precedes publication. The task publishes the crate before the npm package. It then pushes an annotated version tag and creates a GitHub release with generated notes.

The task saves recovery state inside `.git`. It never rolls back commits or registry uploads. Publication across two registries is not atomic.

### Resume an interrupted release

Resolve the reported error before recovery.

If CI failed, rerun the failed jobs on GitHub.

Resume the saved version:

```sh
mise run release -- --resume
```

Recovery repeats local checks without another version increment. It omits an upload if the registry contains that version after a recorded publication attempt. It also omits an existing GitHub release.

A forced process exit can leave a release lock. Normal failure removes the lock but retains recovery state.

If the task reports a stale lock, make sure that no release process remains active.

Remove only the stale lock directory:

```sh
rmdir "$(git rev-parse --git-path hypergraft-release.json.lock)"
```

Do not delete the recovery state after a publication attempt. The saved version prevents an accidental second release.

## Pull requests

- Keep each pull request narrow.
- Explain the protocol or security effect.
- Update documentation when a public contract changes.
- Update the [agent integration guide](docs/agent-guide.md) when public APIs or integration constraints change.
- Include test results in the pull request description.
- Report security defects through `SECURITY.md`.
