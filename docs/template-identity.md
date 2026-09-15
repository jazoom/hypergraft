# Template identity and reconciliation

## Status and boundaries

This normative target contract accompanies [Template language](template-language.md). Browser preflight enforces its key validation rules.

The compiler emits revision-safe keys and supports scoped typed composition and semantically keyed loops. Block selection and the correspondence rules remain future work. Morphlex does not implement the target correspondence contract.

Complete `children` output describes authoritative contents of a retained target. `append` remains cumulative. Neither endpoint retains a previous DOM snapshot or per-client baseline.

## Effective keys

An element's effective key follows this precedence:

1. A present, valid, no-namespace `data-graft-key` attribute supplies a marker key.
2. An `id` supplies an ID key when the marker is absent.
3. Otherwise the element is unkeyed.

Marker keys and ID keys occupy separate domains. Equal attribute strings across those domains do not match. Within each domain, equality compares the complete decoded attribute value exactly, without case folding. An empty or malformed present marker is an error, never ID fallback.

IDs retain the existing protocol syntax and document-wide uniqueness rules, even when markers take precedence.

The compiler adds a marker only when an authored element has neither identity attribute. It creates no public IDs. Text and comment nodes remain unkeyed. Implied browser elements remain unkeyed unless authored markup supplies their identity.

## Marker encoding

A decoded marker attribute contains at most 1024 UTF-8 bytes. This new metadata bound does not increase any existing resource limit. HTML entity decoding precedes validation and byte measurement.

Accepted forms are:

```text
u:<hex>
g1:<namespace>:<slot>:<scope>
```

`u:` is the authored namespace. Its payload is a non-empty, even-length sequence of lowercase hexadecimal digits. Each pair represents one opaque byte. For example, `u:7265616479` is a stable authored marker for protocol samples.

`g1:` is reserved for compiler identity format 1. Its namespace is exactly 64 lowercase hexadecimal digits. Its slot is canonical unsigned decimal, from 0 through 18446744073709551615, without leading zeroes except `0`.

Its scope is lowercase hexadecimal for the binary scope format below. An empty scope has zero characters after the final colon. No additional colons, whitespace or suffixes are valid. Uppercase hex, odd hex lengths and unknown prefixes are errors.

Authored source can declare only valid `u:` markers, not `g1:` markers. Validation uses the complete decoded attribute value, including literal character references and interpolated data. Malformed, reserved or over-bound literal values are compiler errors. Evaluated violations fail the render. Browser validation accepts valid generated markers without an origin claim. Identity metadata is not authentication.

Evaluated keys are public DOM data. They must not contain secrets. Encoding is not encryption. Errors must exclude keys and HTML from HTTP output and live diagnostics.

## Canonical semantic values

The encoder accepts these Rust values and references to them:

| Rust value                                 | Binary value encoding                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `str`, `String`                            | ASCII `s`, followed by a frame of UTF-8 bytes                             |
| All signed and unsigned integer primitives | ASCII `i`, followed by a frame of canonical decimal ASCII                 |
| `bool`                                     | ASCII `b`, followed by one byte, `0x00` or `0x01`                         |
| Tuples with 1 through 12 supported members | ASCII `t`, a four-byte member count, then a frame for each encoded member |

A frame is a four-byte unsigned big-endian byte length followed by exactly that many bytes. Tuple counts use unsigned big-endian encoding. Strings receive no Unicode normalisation. Empty strings are supported semantic values.

Integer encoding has no plus sign, padding or negative zero. Equal mathematical integers have equal encodings regardless of Rust width or signedness. String `"1"` differs from integer `1`. Floats, collections, unit and arbitrary `Display` or `Debug` values are unsupported types.

Unsupported types produce a Rust trait-bound error. Applications can explicitly convert domain identifiers to a supported type. There is no unstable `Debug` conversion or generic custom encoder in format 1.

A scope is a concatenation of frames, each containing one canonical semantic value. Decoding must consume all bytes and validate each value recursively. Integer payloads span the union of `i128` and `u128` values.

The decoder rejects:

- Truncated frames or trailing bytes within a value frame.
- Unknown tags or noncanonical integers, including values outside the supported integer range.
- Invalid UTF-8 within string payloads.
- Boolean payloads other than exactly one `0x00` or `0x01` byte.
- Tuple counts outside 1 through 12 or member frames that disagree with the count.

A semantic value or accumulated scope above 1024 binary bytes fails the render. The final marker must also satisfy the stricter 1024-byte textual bound. Length overflow fails rather than truncates. Recursive decoding uses an explicit stack bounded by input bytes.

For example, integer `7` encodes as `690000000137`. Its scope frame is `00000006690000000137`. Tuple framing distinguishes `("ab", "c")` from `("a", "bc")` without separator ambiguity.

## Namespace and slots

The namespace is the full lowercase SHA-256 digest of this byte sequence:

```text
ASCII("hypergraft-template-identity\0")
frame(ASCII("1"))
frame(UTF8(CARGO_PKG_NAME))
frame(UTF8(normalised_relative_path))
frame(complete_source_bytes)
```

Frames use the length format above. Source must be UTF-8. Source bytes include whitespace, comments and original line endings. Unrepresentable frame lengths are compile errors.

The digest uses no checkout path, timestamp, package version or render counter. A complete-source revision deliberately resets all generated keys. Identical package names, logical paths and source bytes reproduce the same namespace across machines.

Slots are zero-based authored start-tag ordinals in complete-source lexical order. All authored elements consume slots, including elements with authored identity. Conditional alternatives consume distinct slots before branch evaluation. Implied elements consume no slots. Blocks and directives consume no element slots.

Block selection never reallocates slots or changes the namespace. Composed templates retain their own namespaces and slots. Digest identity is deterministic, not a guarantee against a cryptographic collision.

## Parent-relative scope

An output context starts with an empty scope unless the caller supplies a scoped value. A loop appends its evaluated key as one scope frame for that iteration. Explicit composition scope appends one frame. Unscoped composition passes the current scope unchanged.

An emitted element uses the active scope for its own generated key. Its child context starts with an empty scope. This reset applies even when the element has an authored marker or ID. After that element ends, output resumes the surrounding scope.

An implied browser parent also establishes a child boundary. The compiler's HTML tree model resets scope at that boundary without annotating the implied element. A directive cannot create an implied parent that survives beyond its body, as [Template language](template-language.md#literal-html-and-structure) specifies.

A row loop inside an authored `tbody` starts after that parent's reset. Each `tr` therefore retains its loop scope. The compiler rejects a row loop directly inside `table` rather than discard its keys at an implied `tbody`.

Wrapper-free loops and composition retain their accumulated scope until an actual parent boundary. A named block contributes no scope frame. A selected block starts at its retained target's child boundary, not at its original page call stack.

Independent output inside wrapper-free repetition needs the exact outstanding semantic scope. Chained `.scoped(a).scoped(b)` appends `a` then `b` in that order. A caller must reproduce those frames when no intervening retained parent resets them.

Explicit markers and IDs are absolute within their sibling domain. The compiler does not rewrite them with semantic scope. Authors therefore own uniqueness of repeated authored identities.

## Executable scoped output

The `GraftTemplate` trait supplies `.scoped(key)`. The wrapper retains the typed fragment and its encoded scope. Invalid metadata fails the render with `TemplateError::InvalidKey`.

```rust
use hypergraft::{GraftTemplate, PatchSet};

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/card.graft.html")]
struct Card;

let mut patches = PatchSet::new();
patches.append("cards", &Card.scoped(41))?;
let first = patches.encode_live()?;

let mut patches = PatchSet::new();
patches.append("cards", &Card.scoped(42))?;
let second = patches.encode_live()?;

let independent = Card.scoped(2).scoped(7);
let mut patches = PatchSet::new();
patches.children("cards", &independent)?;
```

Each append uses a separate batch. Equal child slots below separate card roots retain equal keys. The explicit scopes distinguish the card roots.

A borrowed scoped fragment retains its frame order, including through a trait object. Explicit composition scope follows the fragment's existing frames.

```rust
let group = Card.scoped(2);
let borrowed = (&group).scoped(7);
assert_eq!(borrowed.render()?, Card.scoped(2).scoped(7).render()?);
```

Direct output accepts a `template::Scope`. Ordinary callers use its empty default. Generated composition passes the active scope or resets it at an actual parent boundary.

```rust
use hypergraft::template::Scope;

let mut html = String::new();
Card.scoped(41).render_into(&mut html, &Scope::default())?;
```

Literal authored markers receive compiler validation after HTML character-reference decoding. Dynamic authored markers receive validation from the exact escaped start tag through the HTML tokenizer. This permits character references across expression boundaries without another template evaluation.

The runtime rejects reserved authored markers and metadata above its byte bound. Error values contain no HTML or evaluated keys. Generated attributes consume the existing response byte budget.

Private Askama adapters still emit legacy HTML without automatic annotations. Their ignored scope parameter does not promise identity for legacy fragments.

## Worked identities

In these examples, `N` denotes the complete 64-digit namespace. `K(N,s,S)` denotes `g1:N:s:hex(S)`, not literal wire syntax. `F(v)` denotes one framed semantic value.

```html
<ul id="tasks">
    {% for task in self.tasks.iter() key(task.id) %}
    <li id="task-{{ task.id }}">
        {% block row_contents(task = task) %}<strong>{{ &task.title }}</strong
        >{% block row_status(task = task) %}<span>{{ task.done }}</span>{%
        endblock %}{% endblock %}
    </li>
    {% endfor %}
</ul>
```

The authored start tags receive slots 0 through 3. For task 7, the row has ID key `task-7`. Its children have `K(N,2,empty)` and `K(N,3,empty)`.

A standalone `row_contents` patch for `task-7` emits those same two keys. A standalone `row_status` emits `K(N,3,empty)`. No row-loop scope enters those children because the retained row resets it.

Task 8 has the same internal keys beneath a different row. This reuse is valid. A source edit changes `N` for page and block output together.

For a card template whose root has slot 0, sibling calls with scopes `"left"` and `"right"` produce distinct roots:

```text
K(card_namespace,0,F("left"))
K(card_namespace,0,F("right"))
```

Both cards' slot-1 children use empty scope beneath their respective roots. Two unscoped calls under one parent collide if their generated root slots agree.

Nested wrapper-free loops with keys `group.id = 2` and `task.id = 7` give each emitted root scope `F(2) || F(7)`. Multiple roots share that scope but have different slots. An intervening authored `section` instead resets the task scope to `F(7)`.

An independent block at the wrapper-free location needs `.scoped(2).scoped(7)`. A tuple scope `(2, 7)` is not equivalent to those two frames.

Successive appended cards with `.scoped(41)` and `.scoped(42)` have distinct roots. Reuse of `.scoped(41)` collides with the surviving first card. An append caller supplies stable entity or batch-instance values, not an implicit renderer counter.

## Duplicate checks and preflight

Each loop invocation tracks canonical evaluated values independently. Duplicate values fail before successful template output, including iterations with no elements or only authored IDs. Different loops do not share this set.

Final DOM collisions are a separate browser invariant. Distinct loop values can still produce colliding authored markers. Independent template calls can also collide without a duplicate loop value.

Whole-batch preflight validates these scopes:

- Every current sibling sequence throughout each affected target subtree, including contents that `children` will replace.
- Every incoming sibling sequence throughout every prepared fragment.
- Incoming append roots together with all surviving target children.
- Each native template's content fragment as a separate parent.
- HTML, SVG and MathML children under the same parent-local rules.

Keys can repeat under distinct parents. Current traversal is iterative and does not consume the incoming node budget. Incoming nodes retain the existing count and depth bounds. Target roots retain their identity and do not become incoming children.

Content inspection precedes each trusted `validateContent` callback. All callbacks complete before a final validation pass over the exact prepared fragments. That pass repeats content constraints and key checks without another callback or HTML sink.

Final document-wide ID validation remains independent. No key rule relaxes target overlap, script rejection or host security responsibilities. All patches pass before any target or title changes.

Key rejection uses `target-content`, without key values or HTML. Complete preflight does not promise rollback after an application-time exception.

## Sibling correspondence

Each parent receives one old-key map and one ordered sequence of old unkeyed nodes. Incoming keyed children use direct key lookup. Incoming unkeyed children use their ordinal among unkeyed siblings, including text and comments.

A keyed node never matches an unkeyed node. An incompatible candidate receives replacement without another search. A replaced ancestor ends all descendant identity. The reconciler never extracts its descendants for reuse elsewhere.

Compatible nodes retain object identity in desired sibling order. Unmatched old nodes disappear. Unmatched incoming nodes enter the document. No identity crosses parents or targets.

Elements require equal namespace URI and local name. Text matches text and comments match comments. Other node-kind changes require replacement. Native template contents recurse through their own parent scope. Attributes synchronise by namespace and local name.

## Form compatibility

The additional table applies only to HTML-namespace elements:

| Candidate pair            | Compatibility                             |
| ------------------------- | ----------------------------------------- |
| `input` / `input`         | Equal effective DOM `type` values         |
| `textarea` / `textarea`   | Compatible                                |
| `select` / `select`       | Compatible, including a `multiple` change |
| `option` / `option`       | Compatible                                |
| `button` / `button`       | Compatible, including a `type` change     |
| Other equal-name elements | Compatible                                |

Missing and invalid input types resolve through the browser's effective `type` property. Different effective types are incompatible without exception. A `text` input and a `search` input therefore require replacement.

## Authoritative control state

The runtime captures detached source control state before placement changes it. This state lasts only for the batch. Equal attributes do not imply equal dirty properties.

Retained and new inputs receive source `defaultValue`, effective `value`, `defaultChecked` and `checked` where the platform supports those properties. `indeterminate` becomes false because HTML supplies no such state. Assignments that already agree are omitted when possible.

A file input always clears its value on authoritative application, including retention. The runtime only assigns the empty string, never a protected non-empty value. It promises no restoration of selected files or other protected browser state.

Textarea children reconcile before `defaultValue` and `value` receive their captured source values. Option `defaultSelected` follows the authored `selected` attribute. Option values follow source attributes and final text.

Each select derives desired selection from its complete incoming option tree before placement. Browser-native defaults apply, including first eligible selection for an ordinary single select without explicit selection. Multiple selects without selected options select none.

After the final option tree exists, the runtime applies the captured selected vector to its corresponding options. A single select also receives its captured selected index, including `-1` for no selection. A multiple select receives no `selectedIndex` assignment because that setter clears other selections.

This policy resolves multiple authored selections through the browser's detached source select semantics. A retained select target in a children-only patch keeps its own `multiple`, `size` and other attributes. Its complete incoming option tree uses those retained attributes for native defaults, not the envelope template's context.

An option-only patch lacks a complete authoritative tree for its owning select. It applies captured option selections in final tree order under that select's native constraints. Unpatched options receive no synthetic authoritative state. Append retains existing options, with selection effects from inserted options under the same native constraints.

Radio resolution occurs after all batch controls enter their final document structure. Group membership follows native form-owner, tree and name rules. Incoming unchecked radios clear first. Incoming checked radios apply in final document order, so the last checked incoming radio wins within a group.

An incoming checked radio can uncheck a surviving radio outside the targets through native group behaviour. A group without an incoming checked radio receives no synthetic selection. HTML does not promise that an unrelated surviving checked radio stays checked after a conflicting authoritative patch.

Disabled and ARIA attributes synchronise, including removal. Every relevant retained element/source pair notifies pending-state ownership even when attributes compare equal. Source attributes remain available until that notification completes.

Progress preserves transport presentation. Cleanup uses the latest applied source, including authoritative absence. A shallow target clone is not an authoritative source for retained target attributes in a children-only patch.

## Focus, moves and islands

Application captures the active node reference before mutation. If that node survives in the document, focus restoration uses it even without an ID or after an ID change. Only removal permits fallback through the original public ID. Private markers never become document-global focus selectors.

Selection capture applies only to textarea and supported input selection types: text, search, URL, telephone and password. Restoration includes direction and clamps offsets to the final value. Unsupported APIs receive no selection call. Focus restoration avoids redundant calls and uses `preventScroll`.

Navigation's subsequent target focus and scroll policy remains unchanged. Removal without a suitable fallback does not promise focus restoration.

Native `moveBefore` applies only when available and platform preconditions hold. Ordinary DOM insertion supplies the fallback. Capability handling must not suppress unrelated application exceptions.

Fallback moves preserve retained object identity, not every native state. Focus restoration cannot guarantee uninterrupted custom-element connection callbacks, embedded browsing state or protected controls.

Island instances follow root object identity. A retained root keeps its instance while server-authored descendants reconcile. Removal, replacement or an island-name change ends the old lifetime with abort before destruction.

## Reconciliation fixture

The executable `protocol-v1.json` fixture contains this `reconciliation` section. Browser preflight consumes its encoding and validation contract.

```json
{
    "reconciliation": {
        "attribute": "data-graft-key",
        "format": 1,
        "maximumBytes": 1024,
        "authoredPrefix": "u:",
        "generatedPrefix": "g1:",
        "namespaceHexDigits": 64,
        "slotMaximum": "18446744073709551615",
        "semanticMaximumBytes": 1024,
        "markerIdDomains": "distinct",
        "scope": "siblings",
        "emptyMarker": "reject",
        "malformedMarker": "reject"
    }
}
```

Named browser cases cover current duplicates, incoming duplicates and append survivors. They also cover malformed frames, exact decoded metadata bounds and reuse under separate parents. Native templates and mixed namespaces use the same cases where applicable.

Cases use initial document markup and generated boundary inputs where necessary. Applicable cases reach complete, stream and live preflight. Rejections use shared expectation `protocol` with browser reason `target-content`.

Compiler identity fixtures remain separate from byte-exact envelope samples. The latter use a stable authored marker. Compiler and browser assertions consume the same fixture revision.

[Compatibility](compatibility.md) records the coordinated rollout decision. Wire version, operations and existing resource limits remain unchanged. A newly discovered wire incompatibility blocks dependent implementation until explicit version approval.
