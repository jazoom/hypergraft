# Anonymous task list

This example is a local Hypergraft integration. It is not a deployment template.

The application is anonymous. It has no sign-in page. It has no database.

The process stores tasks in memory. A restart restores the seed data.

The server listens on `127.0.0.1:3000`. Origin checks and the content security policy still apply.

## Launch the example

Install the pinned tools:

```sh
mise install
pnpm install --frozen-lockfile
```

Build the browser assets and start the server:

```sh
mise run example
```

Open `http://127.0.0.1:3000/tasks`.

The launch command builds `/assets/main.js` and `/assets/style.css` before the process starts. A clean checkout can compile the crate before that asset build.

## Try document load and enhanced navigation

1. Open the task list.
2. Reload the page. The same seed tasks must appear.
3. Open a task through its detail link.
4. Use **Back to tasks**.

JavaScript is required for enhanced navigation. Real links still work without it. After an enhanced navigation, focus moves to `main`.
