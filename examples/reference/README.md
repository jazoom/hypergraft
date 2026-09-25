# Anonymous task list

This example is a local Hypergraft integration. It is not a deployment template.

The application is anonymous. It has no sign-in page. It has no database.

The process stores tasks in memory. A restart restores the seed data.

The server defaults to `127.0.0.1:3000`. `HYPERGRAFT_REFERENCE_PORT` selects another non-zero loopback port. Origin checks and the content security policy use the same address.

## Template organisation

Page-local fragments live in named Askama blocks within their page template. The initial page and its patches use the same source markup.

| Template                             | Block                  | Retained target        |
| ------------------------------------ | ---------------------- | ---------------------- |
| [`tasks.html`](templates/tasks.html) | `task_filter`          | `task-filter`          |
| [`tasks.html`](templates/tasks.html) | `task_results`         | `task-results`         |
| [`tasks.html`](templates/tasks.html) | `task_create`          | `task-create`          |
| [`tasks.html`](templates/tasks.html) | `task_create_filters`  | `task-create-filters`  |
| [`tasks.html`](templates/tasks.html) | `task_create_feedback` | `task-create-feedback` |
| [`task.html`](templates/task.html)   | `task_detail`          | `task-detail`          |

Each target wrapper stays outside the block that supplies its children. Block-specific types in [`pages.rs`](src/pages.rs) select those blocks through `#[template(path = "tasks.html", block = "task_results")]` or the corresponding detail selector.

A block-specific type needs only its referenced fields. For example, `TaskResults` takes only the task list, even though its source file also contains forms.

The create block contains nested filter and feedback blocks. A create rejection can patch those smaller targets without replacement of the draft title control.

Block nesting does not permit overlapping targets in one batch. The response selects either the parent target or its disjoint descendants.

[`document.html`](templates/document.html) remains the shared document shell. Separate files suit independently reused templates rather than every page-local fragment.

The [host guide](../../docs/host-integration.md#page-local-blocks) describes both block-specific types and accessors on a complete page value.

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

## Navigation feedback

The example uses `bindReadFeedback` and host-authored slots outside `main`. Navigation and submitted GET filters share a slim indeterminate bar after 200 ms. Screen readers receive a status announcement at that time. The current content remains visible until the authoritative response arrives.

Reduced motion keeps the bar static. Pending feedback leaves the keyboard focus style intact.

The example also uses `bindNavigationRecovery`. A later task link replaces an earlier safe request. The shared bar supplies pending feedback without a Cancel button.

A transport failure before document mutation keeps the current page and its draft title. Retry starts a fresh request through a real link. Dismiss hides the failure. Neither action replays a command.

Invalid responses and partial patch failures retain document recovery. Failed or cancelled history traversal reloads the current URL without another history entry. The [navigation lifecycle](../../docs/browser-runtime.md#navigation-lifecycle) describes these boundaries.

### Run beside another application

Use a separate loopback port:

```sh
HYPERGRAFT_REFERENCE_PORT=3003 mise run example
```

Open `http://127.0.0.1:3003/tasks`.

### Review immediate feedback

1. Open the task list.
2. Set a high-latency network profile in the browser developer tools.
3. Activate a task detail link.
4. Make sure that the link keeps its normal appearance during the request.
5. Make sure that the list stays visible until the detail arrives.
6. Make sure that the top bar appears after 200 ms.
7. Make sure that the bar disappears after navigation.
8. Use Tab to focus **Back to tasks**.
9. Press Enter.
10. Make sure that keyboard activation gives the same feedback.
11. Disable the network throttle.
12. Make sure that fast navigation does not flash the shared status.
13. Enable reduced motion.
14. Repeat the slow navigation.
15. Make sure that feedback remains visible without animation.

### Review replacement and recovery

1. Open the task list.
2. Select a high-latency network profile in the developer tools.
3. Activate **Write the weekly notes**.
4. Before its response arrives, activate **Prepare the public preview**.
5. Make sure that only the latest destination appears.
6. Return to the list.
7. Enter a draft title without submission.
8. Block the next task GET in the developer tools.
9. Activate that task link.
10. Make sure that the list and draft title remain.
11. Make sure that the recovery message appears without a document reload.
12. Remove the request block.
13. Use Tab to focus **Retry navigation**.
14. Press Enter.
15. Make sure that the destination appears.
16. Press Back once.
17. Make sure that the list appears without a duplicate history entry.
18. Repeat the failed request.
19. Press **Dismiss**.
20. Make sure that dismissal sends no request.
21. Block a traversal GET after the browser changes its URL.
22. Make sure that document recovery uses that URL rather than an intact-page retry message.
23. Remove the request block.
24. Reload the document.

## Search the task list

The list filter is a canonical GET form. It accepts a search string and a status of `all`, `open` or `done`.

The server removes control characters and trims the search string. It truncates the search to 120 Unicode scalar values. An unknown status becomes `all`.

A browser without JavaScript still submits the form as a document request.

Enhanced search disables the Filter button immediately. Slow searches reveal the shared top bar and screen-reader status after 200 ms. Fast searches remain silent. Commands and background live updates do not start this bar.

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

### Review search feedback

1. Open the developer tools.
2. Set a high-latency network profile.
3. Enter `notes` in Search.
4. Press Filter.
5. Make sure that the previous results remain visible while the request is active.
6. Make sure that the top bar appears after 200 ms.
7. Make sure that the bar disappears when the results arrive.
8. Disable the network throttle.
9. Repeat the search.
10. Make sure that fast searches do not flash the bar.

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

## Task entry effects

The [browser entry](browser/main.ts) registers one named `task` effect through `startHypergraft({ enterEffects })`. The [list template](templates/tasks.html) selects it on each row:

```html
<li id="task-{{ task.id }}" data-graft-enter="task"></li>
```

A row fades from opacity `0.2` to `1` over 200 milliseconds when its identity enters a targeted patch. Command responses and live updates use the same effect. Stable task IDs prevent replay when a row remains in the results, including status changes.

Entry does not mean task creation. A filter can remove a task and later introduce its row again. That row receives the effect too.

Initial documents and enhanced navigation receive no entry effects. Under reduced motion, Hypergraft suppresses this effect because the definition omits a `reducedMotion` alternative. Rows remain visible without animation. Task feedback remains available in the existing status text.

The example needs no animation observer or settlement listener. The [entry-effect contract](../../docs/browser-runtime.md#entry-effects) describes identity comparison and effect lifetimes.

### See task entry in two tabs

1. Open `http://127.0.0.1:3000/tasks` in two tabs.
2. In the first tab, create a task named `Watch the entry effect`.
3. Make sure that only the new row fades in each tab.
4. In the first tab, filter by `Watch the entry effect`.
5. Clear Search.
6. Press Filter.
7. Make sure that the other rows fade as they return.
8. Reload the page.
9. Make sure that no rows animate.
10. Enable reduced motion in the browser developer tools.
11. Create another task.
12. Make sure that its row appears without animation.

## Complete and reopen a task

The detail page contains a command form. JavaScript is required for the command.

The form sends the expected revision in a hidden field. The server compares that revision and applies the status change in one store lock. A successful complete or reopen increments the revision. The response replaces the children of `task-detail` with the current task.

A revision mismatch or an incompatible transition returns a 409 patch. The patch contains the current task and conflict feedback. The runtime does not retry the command.

Status commands use the same 4096-byte body limit as creation. Oversized or malformed bodies receive a 422 patch with the current task. Duplicate or unknown fields also receive a 422 patch. The store does not change. The response does not echo the body.

An unknown task identifier receives a no-store 404 response.

### Complete a task

1. Open `http://127.0.0.1:3000/tasks`.
2. Open Write the weekly notes.
3. Press Complete.
4. Make sure that the status is Done.
5. Make sure that the form is Reopen.

### Reopen a task

1. Stay on that detail page.
2. Press Reopen.
3. Make sure that the status is Open.
4. Make sure that the form is Complete.

### Show a revision conflict in two tabs

1. Open Write the weekly notes in two tabs.
2. Make sure that both tabs show Open and Complete.
3. In the first tab, press Complete.
4. Make sure that the first tab shows Done and Reopen.
5. In the second tab, press Complete.
6. Make sure that the second tab shows the conflict feedback.
7. Make sure that the second tab now shows Done and Reopen.
8. Make sure that the command does not retry by itself.

## Watch live updates

The list filter form is a live projection. JavaScript is required for live updates.

The server patches `task-results` after a successful create or status change. The filter form and the create form stay outside that target.

The live status region sits outside `main`. It presents a disconnected state and a terminal stop. It does not run a second retry timer. A live patch event means a projection applied. An open socket does not prove that the list is current.

Unsafe uncertainty feedback stays in front of this connection text.

A command suspends live work. No subscription starts during the command. After a known create result, live work resumes with the command query. That query comes from the hidden filter fields. The resumed subscription uses that same query. The filter controls, the results and the browser URL use it too.

A server restart restores the seed data. It does not keep tasks from the previous process. After a retryable disconnection, the browser reconnects when the process returns. A terminal stop requires a page reload.

The anonymous guard allows eight concurrent sockets across the process. Each connection owns an admission permit until the socket session ends.

Subscription URLs include every filter control, including an empty `q` and the default `status=all`. The browser URL omits these defaults. Both URLs describe the same normalised query.

### See a change in two list tabs

1. Open `http://127.0.0.1:3000/tasks?status=open` in two tabs.
2. Make sure that both tabs show Write the weekly notes.
3. Open Write the weekly notes in a third tab.
4. Press Complete.
5. Make sure that both list tabs remove that task without a reload.
6. Make sure that the live status reports that the list updated.

### Resume live work after a pending filter GET

1. Open `http://127.0.0.1:3000/tasks`.
2. Open the developer tools. Watch the WebSocket frames.
3. Throttle the network.
4. Choose Done in Status.
5. Press Filter.
6. Before the filter response arrives, enter `Live command query` in Title.
7. Press Create.
8. Make sure that no subscribe frame is sent during the command.
9. Make sure that Search is empty and Status is All.
10. Make sure that the URL is `/tasks`.
11. Make sure that the new task is in the results.
12. Make sure that the next subscribe URL is `/tasks?q=&status=all`.
13. Reload the page.
14. Make sure that the same filter controls and results remain.

Repeat the steps with a blank title instead of a valid title.

1. Choose Open in Status.
2. Press Filter. Wait for the results.
3. Throttle the network.
4. Choose Done in Status.
5. Press Filter.
6. Before the filter response arrives, enter only spaces in Title.
7. Press Create.
8. Make sure that no subscribe frame is sent during the command.
9. Make sure that Search is empty and Status is Open.
10. Make sure that the URL is `/tasks?status=open`.
11. Make sure that the rejection adds no task.
12. Make sure that the next subscribe URL is `/tasks?q=&status=open`.
13. Reload the page.
14. Make sure that the same filter controls and results remain.

### Resume live work after an unsubmitted filter edit

1. Open `http://127.0.0.1:3000/tasks`.
2. Choose Open in Status.
3. Press Filter.
4. Enter `zzzz` in Search. Do not press Filter.
5. Enter `Query from hidden fields` in Title.
6. Press Create.
7. Make sure that no subscribe frame is sent during the command.
8. Make sure that Search is empty and Status is Open.
9. Make sure that the URL is `/tasks?status=open`.
10. Make sure that the next subscribe URL is `/tasks?q=&status=open`.
11. Reload the page.
12. Make sure that the same filter controls and results remain.

Repeat the steps with a blank title instead of a valid title.

1. Choose Done in Status.
2. Press Filter.
3. Enter `zzzz` in Search. Do not press Filter.
4. Enter only spaces in Title.
5. Press Create.
6. Make sure that no subscribe frame is sent during the command.
7. Make sure that Search is empty and Status is Done.
8. Make sure that the URL is `/tasks?status=done`.
9. Make sure that the rejection adds no task.
10. Make sure that the next subscribe URL is `/tasks?q=&status=done`.
11. Reload the page.
12. Make sure that the same filter controls and results remain.

### Restart the server

1. Create a task named `Must not survive restart`.
2. Stop the server process.
3. Make sure that the live status shows a disconnected or stopped state.
4. Start the server again with `mise run example`.
5. If live updates stopped permanently, reload the page.
6. Make sure that the created task disappears from the results.
7. Make sure that the seed tasks are back.
