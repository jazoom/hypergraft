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

## Search the task list

The list filter is a canonical GET form. It accepts a search string and a status of `all`, `open` or `done`.

The server removes control characters and trims the search string. It truncates the search to 120 Unicode scalar values. An unknown status becomes `all`.

A browser without JavaScript still submits the form as a document request.

1. Open `http://127.0.0.1:3000/tasks`.
2. Enter `notes` in Search.
3. Choose Open in Status.
4. Press Filter.
5. Make sure that the list shows only Write the weekly notes.
6. Reload the page.
7. Make sure that the same result and the same filter values remain.

Open `http://127.0.0.1:3000/tasks?q=protocol&status=done` directly.

The page must show Review the protocol bounds. The controls must keep that query.

Reload the page.

The same result and the same filter values must remain.

Open `http://127.0.0.1:3000/tasks?status=bogus&q=zzzzzzzz`.

The status control must show All. The results must say that no tasks match this filter. The filter controls must stay available.
