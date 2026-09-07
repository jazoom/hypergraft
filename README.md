# Hypergraft

Hypergraft is a bounded HTML-over-HTTP and WebSocket protocol for server-rendered Axum applications.

Ordinary Axum pages already serve documents, links and forms. Hypergraft adds enhanced navigation, command patches and live projections to those pages. The server stays authoritative.

JavaScript is required for live projections and command patches. HTTP still serves each initial document, deep link, reload and canonical GET page. Real links and forms define navigation, queries and commands. A native POST without patch metadata receives a no-store 400 before domain work.

Hypergraft is not a drop-in htmx substitute. htmx supports backend-independent HTML swaps with attributes that select targets and swap behaviour. Hypergraft is a closed protocol for Axum and Askama. It owns request classification, bounded envelopes, one live socket and a JavaScript-required runtime. Commands are patch-only. The version 1 Rust host does not add a second adapter.

The source-preview Rust API and browser API remain experimental. Protocol version 1 is the versioned wire contract.

## Run the example

The repository includes an anonymous shared task list. It has no sign-in page and no database. The process stores tasks in memory. A restart restores the seed data.

The example needs mise and a local checkout. mise supplies the pinned Rust, Node.js and pnpm versions.

From the repository root, install the pinned tools and dependencies:

```sh
mise install
pnpm install --frozen-lockfile
```

Build the browser assets and start the server:

```sh
mise run example
```

Open `http://127.0.0.1:3000/tasks`.

This launch does not install Playwright browsers. Contributor browser tests need extra setup. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [Compatibility](docs/compatibility.md).

## See a live update

JavaScript is required for this walkthrough.

1. Open `http://127.0.0.1:3000/tasks?status=open` in two tabs.
2. Make sure that both tabs show Write the weekly notes.
3. In the second tab, open Write the weekly notes.
4. Press Complete.
5. Make sure that the first tab removes that task without a reload.

The example README has longer walkthroughs:

- [Create tasks with validation](examples/reference/README.md#create-a-task)
- [Complete tasks and show a revision conflict](examples/reference/README.md#complete-and-reopen-a-task)
- [Watch live updates after commands](examples/reference/README.md#watch-live-updates)

## What to read next

- [Anonymous task list](examples/reference/README.md)
- [Protocol version 1](docs/protocol-v1.md) and [`protocol-v1.json`](protocol-v1.json)
- [Host integration](docs/host-integration.md)
- [Browser runtime](docs/browser-runtime.md)
- [Live](docs/live.md)
- [Security](docs/security.md)
- [Compatibility](docs/compatibility.md)

The [streamed progress recipe](docs/host-integration.md#streamed-command-recipe) and [island recipe](docs/browser-runtime.md#island-recipe) are separate from the reference application.

## Adoption constraints

Patch targets use global document identifiers. Identifiers in inserted content and surviving document elements must match `^[A-Za-z][A-Za-z0-9_.:-]{0,127}$`. They must be unique across the final document, including regions outside patch targets.

Version 1 does not patch the document head. A titled patch updates `document.title` only.

Version 1 does not restore history scroll positions. After a children patch, the previous offset belongs to different content.

If the application serves private data, the host owns authentication and authorisation. Anonymous public data does not require authentication. Origin checks and CSP still apply.

## Contribute

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you propose a change. Report security issues through [SECURITY.md](SECURITY.md).
