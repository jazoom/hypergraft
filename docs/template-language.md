# Template language

## Status and authority

This document defines the target compiler contract authorised by [NEXT.md](../NEXT.md). It replaces that plan's illustrative syntax. It does not describe completed compiler support.

[Template identity](template-identity.md) defines the associated identity format. [Compatibility](compatibility.md) defines the rollout boundary. The executable protocol fixture remains unchanged in this specification task.

Templates are trusted application source, not a sandbox. Rust ownership and type rules apply. Axum remains the host.

## Files and derives

Source files use the `.graft.html` suffix. Each path is relative to the consumer crate's `CARGO_MANIFEST_DIR`, not the process directory or an implicit template directory.

```rust
#[derive(GraftTemplate)]
#[graft(path = "templates/tasks.graft.html", block = "task_results")]
struct TaskResults<'a> {
    tasks: &'a [Task],
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/paragraph.graft.html")]
struct Paragraph<'a> {
    text: &'a str,
}
```

Path syntax uses `/` separators and UTF-8 components. Lexical normalisation removes empty components and `.` components. Each `..` removes one preceding component. An escape above the manifest directory is an error.

Absolute paths, backslashes, drive prefixes and an empty normalised path are errors. The final component must end with `.graft.html`. Physical file resolution does not alter logical identity. Symlinks do not contribute their resolved paths to identity.

Logical identity comprises the consumer's Cargo package name and normalised relative path. The package version, Rust type name and selected block do not contribute. Separate packages with identical names and paths need explicit instance scopes when their outputs share a parent.

The derive resolves the runtime crate through Cargo dependency metadata, including renamed dependencies. Derives within Hypergraft use the same public interface.

Every source dependency receives a stable Cargo-compatible rebuild reference, such as `include_str!`. A source edit triggers recompilation without a Rust source edit.

## Literal HTML and structure

The compiler parses HTML with source positions before code generation. Authored elements and implied browser elements remain distinct. Void elements, optional end tags and HTML namespace transitions follow HTML tree construction rules.

Literal markup retains its original bytes except for generated identity attributes. Directives emit no delimiter bytes. Whitespace outside directives remains literal, including indentation around blocks. There is no whitespace-trim syntax.

Implied elements receive no generated attributes. For example, a browser-created `tbody` remains unkeyed. SVG and MathML elements receive annotations only when their source contains an authored start tag.

Native `template` contents form a separate child sequence. Typed output must suit its insertion context. The compiler cannot infer a composed template's eventual browser repair from its Rust type.

Control-flow boundaries must preserve one unambiguous HTML parser state. Each branch and loop body ends in the same parent context in which it starts. Optional end tags remain valid when their implied closure stays within that sequence. Cross-branch closure and foster-parented dynamic sequences are errors.

A directive cannot create an implied parent that survives beyond its body. For example, repeated `tr` output under `table` requires an explicit surrounding `tbody`. Literal `<table><tr><td>Value</table>` remains valid. This restriction prevents an implied parent from discarding semantic scope or changing its placement between iterations.

## Escaped expressions

`{{ expression }}` evaluates one Rust expression and emits its `Display` output as escaped data. Generated code borrows formatting arguments rather than implicitly cloning fields.

Text and quoted attributes use these exact substitutions:

| Character | Output   |
| --------- | -------- |
| `&`       | `&amp;`  |
| `<`       | `&lt;`   |
| `>`       | `&gt;`   |
| `"`       | `&quot;` |
| `'`       | `&#39;`  |

Other Unicode characters pass through unchanged. Browser HTML parsing still applies its normal character processing. HTML escaping does not validate URLs or sanitise application data.

```html
<p>{{ &self.text }}</p>
<a href="/tasks/{{ self.id }}" title="{{ &self.title }}">Task</a>
<title>{{ &self.title }}</title>
<textarea>{{ &self.text }}</textarea>
```

Both single-quoted and double-quoted attribute values support interpolation. Unquoted dynamic values are errors. Dynamic tag names, attribute names and end tags are errors.

HTML-namespace `title` and `textarea` use RCDATA. They permit escaped expressions but no directives, including composition or control flow. Literal character references retain HTML semantics. The browser's initial textarea newline rule remains in force.

The parser determines dynamic contexts from namespace and HTML tokenizer state, not local name alone. An SVG `title` therefore uses ordinary node content. Interpolation and directives in doctypes, processing instructions and foreign CDATA sections are errors.

Script, style and other raw-text elements permit literal content only. HTML comments permit literal content only. Template openers in these contexts produce diagnostics, not guessed escaping. This rule also rejects dynamic comment delimiters.

Literal template openers in ordinary text can use HTML character references for their braces. Raw-text source cannot use template syntax as an escape mechanism.

## Rust token boundaries

The scanner recognises Rust tokens before it recognises a closing template delimiter. A delimiter closes only outside literals and comments, with no open Rust parentheses, brackets or braces.

The expression after token extraction must parse with `syn`. Rust macros, blocks and nested expressions retain Rust syntax. Hypergraft supplies no filter language.

```text
{{ "a }} b" }}
{{ r###"raw }} and {% text"### }}
{{ { let pair = ('}', '\''); pair.0 } }}
{{ { /* outer /* nested }} */ comment */ "ok" } }}
{{ { // }} is inside this line comment
    "ok"
} }}
{{ self.value.as_ref().map(|value: &'a str| value.len()).unwrap_or(0) }}
{% if self.text.contains("%}") %}Yes{% endif %}
```

The examples define lexical boundaries, not independent Rust type validity. A character literal consumes its closing quote. A lifetime token such as `'a` does not start a string. Raw strings end only at their matching quote and hash count. Nested block comments and line comments follow Rust rules.

For `for`, the separator `in` follows a complete Rust pattern. The final top-level `key(...)` suffix follows a complete iterable expression. For `render`, the optional final top-level `scope(...)` suffix follows a complete expression. Parentheses disambiguate an expression with a conflicting trailing token sequence.

## Branches and loops

```html
{% if self.ready %}
<p>Ready</p>
{% else if self.waiting %}
<p>Wait</p>
{% else %}
<p>Unavailable</p>
{% endif %} {% if let Some(task) = self.task.as_ref() %}
<p>{{ &task.title }}</p>
{% endif %} {% for task in self.tasks.iter() key(task.id) %}
<li>{{ &task.title }}</li>
{% endfor %}
```

`else if let` also follows Rust branch semantics. Branch-local pattern bindings stay within their Rust scope. Every branch closes with `endif`. Every loop closes with `endfor`. A loop has no `else` clause.

Every loop requires a semantic key. The key expression executes once per iteration, after pattern binding and before body output. Duplicate evaluated keys fail the render even when an iteration emits no nodes. [Template identity](template-identity.md) defines supported values and duplicate equality.

Iteration positions are not semantic entity keys. Insertions and reorder preserve entity keys only when the application supplies stable values.

## Conditional attributes

Branches within a start tag can emit complete attributes, including boolean attributes. Each alternative returns to the between-attributes state. Literal separators must keep emitted attributes separate.

```html
<option value="open" {% if self.open %}selected{% endif %}>Open</option>
<button {% if self.busy %}disabled aria-busy="true" {% endif %}>Save</button>
```

Attribute branches support `if`, `if let`, `else if` and `else`. Loops, blocks and composition within start tags are errors. Directives cannot split names, equals signs or quote boundaries. Attribute declarations that can coexist on one execution path must not duplicate a name. Mutually exclusive alternatives can declare the same non-identity attribute.

Authored `id` and `data-graft-key` declarations must be unconditional. Their quoted values can contain escaped expressions. Any conditional identity declaration is an error, even when every alternative supplies it. Automatic identity therefore never depends on branch absence.

## Named blocks

A named block contains complete child-node sequences without a synthetic wrapper. A block contributes its body to full output. Selection emits only that body and evaluates no surrounding page expressions.

```html
<ul id="task-results">
    {% block task_results %} {% for task in self.tasks.iter() key(task.id) %}
    <li id="task-{{ task.id }}">
        {% block row_contents(task = task) %}
        <strong>{{ &task.title }}</strong>
        {% block row_status(task = task) %}
        <span>{{ task.done }}</span>
        {% endblock %} {% endblock %}
    </li>
    {% endfor %} {% endblock %}
</ul>
```

Block syntax is `block name` or `block name(binding = expression, ...)`, with `endblock` as its closer. Names and bindings are Rust identifiers. Block definitions have file-wide unique names.

In full output, argument expressions execute once each, from left to right, before the body starts. All arguments use the surrounding context, not other inputs from the same declaration. Each resulting binding is a local Rust value within the body. For `task = task`, a borrowed loop item remains borrowed.

In standalone output, argument expressions do not execute. Each binding borrows the same-named field from the narrow struct. Thus `row_contents` and `row_status` each require a `task` field. Generated code uses `let task = &self.task` without a clone.

```rust
#[derive(GraftTemplate)]
#[graft(path = "templates/tasks.graft.html", block = "row_contents")]
struct RowContents<'a> {
    task: &'a Task,
}
```

A nested block declares every surrounding local that its body requires. Its full-output argument can refer to an enclosing block input. Independent selection reads its own same-named field instead.

Direct `self.field` access always refers to the selected derive's struct. A block without local inputs can therefore use narrow fields directly, as `task_results` does.

The compiler tracks template-introduced local bindings. A reference to an enclosing local without a declared block input is a compiler-owned error. Locals declared inside Rust expressions follow ordinary Rust rules. Arbitrary application paths remain Rust names, not inferred block captures.

Unknown selectors, duplicate block names and duplicate input names produce diagnostics. Blocks cannot cross element boundaries or appear inside attributes, comments, RCDATA or raw text. Selection retains complete-source namespace and slots.

## Typed composition and scope

```html
<main>{% render &self.body %}</main>
{% render &self.card scope(self.card_id) %}
```

`render` writes a value through `GraftTemplate`, not through `Display`. It is valid only at ordinary node-content boundaries. Composition in attributes, RCDATA, raw text or comments is an error.

The runtime spelling for explicit scope is `template.scoped(key)`. The wrapper implements `GraftTemplate` and works with either patch operation. This target API becomes executable in the scoped-identity task.

```rust
let fragment = card.scoped(card_id);
patches.append("cards", &fragment)?;
```

`render expression scope(key)` is equivalent to a scoped value at that location. Scope values use the key encoder from [Template identity](template-identity.md). No automatic call counter or call-site scope exists. Repeated sibling instances need distinct explicit or inherited semantic scopes.

`render_into` writes directly to an output destination. Its internal output context carries parent-relative scope when identity support enters the runtime. `render` returns complete HTML or an error. A failed patch discards partial output before batch insertion.

Nested failures propagate through typed composition. Runtime errors expose bounded classifications, not HTML, evaluated keys or arbitrary underlying error text.

## Diagnostics and exclusions

Compiler-owned diagnostics include the normalised template path and one-based line and column. They cover HTML structure, unsupported contexts and template grammar. Source byte ranges support those positions.

Generated Rust preserves expression tokens and records their source ranges. Rust type errors can point into macro-generated code. The compiler documents this limitation rather than promises native template spans for every Rust error.

The initial language excludes:

- Template inheritance.
- Dynamic template source.
- Generic trusted-string conversion or a `safe` filter.
- An application helper registry.
- Implicit captures from a complete page into an independent block.

Editor grammar and semantic editor support remain separate workstreams.
