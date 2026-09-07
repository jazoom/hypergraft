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

## Create a task

The list page contains a create form. JavaScript is required for the command.

The server stores at most 100 tasks. A title must contain 1 to 120 Unicode scalar values after trim. The server does not truncate a title to accept it.

Command bodies must stay within 4096 bytes. That limit covers a valid title, the hidden filter fields and form-encoding overhead.

The hidden filter fields are the authoritative query for every known create outcome. The response updates the filter controls, the results, the hidden fields and the browser URL to that query.

If body extraction or decoding fails, the response uses an empty search and status `all`. The feedback explains that filter reset.

Malformed percent escapes and invalid UTF-8 receive a 422 response before task mutation.

A GET filter response updates the hidden fields. It does not replace the title control or the create feedback.

A native POST without patch metadata receives 400. A foreign Origin receives 403. Neither case changes the task store.

A patch construction failure returns a secret-safe 500 response. The runtime does not retry the command.

### Create a valid task

1. Open `http://127.0.0.1:3000/tasks`.
2. Enter `Read the security notes` in Title.
3. Press Create.
4. Make sure that the list contains the new task.
5. Make sure that the title control is empty.

### Reject a blank title

1. Enter only spaces in Title.
2. Press Create.
3. Make sure that the title control still contains the spaces.
4. Make sure that the feedback tells you to enter a title.
5. Reload the page.
6. Make sure that the extra task is absent.

### Escape title markup

1. Enter `<script>alert(1)</script>` in Title.
2. Press Create.
3. Make sure that the list shows those characters as text.

### Hide a new task with the active filter

1. Choose Done in Status.
2. Press Filter.
3. Enter `Hidden by filter` in Title.
4. Press Create.
5. Make sure that the results still omit the new task.
6. Make sure that the feedback contains a detail link.
7. Open that link.

### Keep a draft across a filter GET

1. Enter `Keep this draft` in Title.
2. Choose Open in Status.
3. Press Filter.
4. Make sure that the title control still contains `Keep this draft`.
5. Make sure that the create feedback did not change.

### Restore the command query after an unsubmitted filter edit

1. Choose Open in Status.
2. Press Filter.
3. Enter `zzzz` in Search. Do not press Filter.
4. Enter `Query from hidden fields` in Title.
5. Press Create.
6. Make sure that Search is empty and Status is Open.
7. Make sure that the URL is `/tasks?status=open`.
8. Make sure that the hidden fields match that query.

### Restore the command query after a cancelled filter GET

1. Open the developer tools.
2. Throttle the network.
3. Choose Done in Status.
4. Press Filter.
5. Before the filter response arrives, press Create.
6. Make sure that the results and filter controls match the hidden fields from the create form.
7. Make sure that the URL matches that query.

### Reject an overlong title

The server counts Unicode scalar values, not UTF-16 code units. The title control permits overlong drafts for server-side validation.

Enter 121 `é` characters in Title.

Press Create.

Make sure that the response preserves the draft and displays the field error.

Send the same command outside the control:

Replace `TITLE` with 121 `é` characters.

```sh
curl -sS -D - \
  -H "Origin: http://127.0.0.1:3000" \
  -H "Graft-Request: patch" \
  -H "Accept: text/vnd.hypergraft.patches+html" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "title=TITLE" \
  --data-urlencode "q=" \
  --data-urlencode "status=all" \
  http://127.0.0.1:3000/tasks
```

The status is 422. The body does not contain the rejected title. Reload the task list. The store is unchanged.

### Reject oversized and malformed bodies

Send an oversized body:

```sh
curl -sS -D - \
  -H "Origin: http://127.0.0.1:3000" \
  -H "Graft-Request: patch" \
  -H "Accept: text/vnd.hypergraft.patches+html" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "title=ok&q=$(python3 -c 'print("a" * 5000)')&status=all" \
  http://127.0.0.1:3000/tasks
```

The status is 422. The feedback explains the filter reset. The body does not echo the request. The envelope stays within 1 MiB.

Send malformed form encoding:

```sh
curl -sS -D - \
  -H "Origin: http://127.0.0.1:3000" \
  -H "Graft-Request: patch" \
  -H "Accept: text/vnd.hypergraft.patches+html" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data 'title=Must%FFnot%persist&q=notes&status=open' \
  http://127.0.0.1:3000/tasks
```

The status is 422. The response resets the filters and omits the rejected title. The store remains unchanged.

Send a JSON body with `Content-Type: application/json`:

```sh
curl -sS -D - \
  -H "Origin: http://127.0.0.1:3000" \
  -H "Graft-Request: patch" \
  -H "Accept: text/vnd.hypergraft.patches+html" \
  -H "Content-Type: application/json" \
  --data '{"title":"Must not persist"}' \
  http://127.0.0.1:3000/tasks
```

The status is 422. The body does not contain `Must not persist`.

Reload the task list. The store is unchanged.

### Reject missing patch metadata and a foreign Origin

```sh
curl -sS -D - -H "Origin: http://127.0.0.1:3000" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "title=Must not persist" \
  http://127.0.0.1:3000/tasks
```

The status is 400. Reload the list. The title is absent.

```sh
curl -sS -D - -H "Origin: http://example.com" \
  -H "Graft-Request: patch" \
  -H "Accept: text/vnd.hypergraft.patches+html" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "title=Must not persist" \
  --data-urlencode "q=" \
  --data-urlencode "status=all" \
  http://127.0.0.1:3000/tasks
```

The status is 403. Reload the list. The title is absent.
