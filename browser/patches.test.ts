// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import fixture from "../protocol-v1.json";
import {
    apply,
    GRAFT_TRANSFER,
    ID_PATTERN_SOURCE,
    MAX_INSERTED_NODES,
    MAX_NESTING_DEPTH,
    MAX_PATCHES,
    MAX_RESPONSE_BYTES,
    MAX_STREAM_BYTES,
    MAX_STREAM_FRAMES,
    MEDIA_TYPE,
    NAVIGATION_STATUS,
    OPERATIONS,
    PATCH_STATUSES,
    PHASES,
    preflight,
    preflightFrame,
    preflightLive,
    PROTOCOL_VERSION,
    STREAM_STATUSES,
} from "./patches";

import { RECONCILIATION } from "./identity";

type ProtocolCase = {
    initialDocument?: string;
    keyInput?: string | { prefix: string; repeat: string; count: number };
    name: string;
    consumers: string[];
    expectation: "accept" | "protocol";
    envelope?: string;
    idByteLength?: number;
    browserReason?: "target-content";
};

function protocolCases(consumer: string): ProtocolCase[] {
    return (fixture as { cases: ProtocolCase[] }).cases.filter((item) =>
        item.consumers.includes(consumer),
    );
}

function response(body: string, status = 200, type = MEDIA_TYPE) {
    const headers: Record<string, string> = { "content-type": type };
    if (status === 429) headers["retry-after"] = "60";
    return [new Response(body, { status, headers }), body] as const;
}

beforeEach(() => {
    document.body.innerHTML =
        '<main id="main"><div id="patient-results"><p id="old">Old</p></div></main>';
    document.title = "Before";
});

test("matches the shared version one fixture", () => {
    expect(RECONCILIATION).toEqual(fixture.reconciliation);
    expect(PROTOCOL_VERSION).toBe(fixture.version);
    expect(MEDIA_TYPE).toBe(fixture.mediaType);
    expect(PATCH_STATUSES).toEqual(fixture.patchStatuses);
    expect(NAVIGATION_STATUS).toBe(fixture.navigationStatus);
    expect(fixture.locationReplacement).toEqual({
        attribute: "location",
        historyOperation: "replace",
        requestKind: "unsafe-patch",
        transferKind: "complete",
    });
    expect(OPERATIONS).toEqual(fixture.operations);
    expect(PHASES).toEqual(fixture.phases);
    expect(STREAM_STATUSES).toEqual(fixture.streamStatuses);
    expect(GRAFT_TRANSFER).toBe(fixture.transfer.header);
    expect({
        responseBytes: MAX_RESPONSE_BYTES,
        patchCount: MAX_PATCHES,
        insertedNodes: MAX_INSERTED_NODES,
        nestingDepth: MAX_NESTING_DEPTH,
        streamFrames: MAX_STREAM_FRAMES,
        streamBytes: MAX_STREAM_BYTES,
    }).toEqual(fixture.limits);
    expect(ID_PATTERN_SOURCE).toBe(fixture.id.pattern);
    expect(new RegExp(ID_PATTERN_SOURCE).test("A:b.c_1")).toBe(true);

    document.body.innerHTML = '<main id="fixture-target"></main>';
    const patchReply = response(fixture.representativePatch)[0];
    expect(preflight(patchReply, fixture.representativePatch)).toMatchObject({
        kind: "patches",
        batch: {
            replaceLocation:
                "http://localhost:3000/items?fixture=one&other=two",
        },
    });
    const navigationReply = response(fixture.representativeNavigation)[0];
    expect(
        preflight(navigationReply, fixture.representativeNavigation),
    ).toMatchObject({
        kind: "navigation",
        destination: expect.stringContaining("/items?fixture=one&other=two"),
    });
    expect(
        preflightLive(fixture.representativeLivePatch).patches[0],
    ).toMatchObject({
        targetId: "fixture-target",
        operation: "children",
    });
    expect(() => preflightLive(fixture.representativePatch)).toThrow();
    expect(() => preflightLive(fixture.representativeNavigation)).toThrow();
});

test("consumes named envelope conformance cases", () => {
    document.body.innerHTML = '<main id="fixture-target"></main>';
    const consumers = [
        "browser-preflight",
        "browser-preflight-live",
        "browser-preflight-frame",
    ] as const;
    let count = 0;
    for (const consumer of consumers) {
        const cases = protocolCases(consumer);
        count += cases.length;
        for (const item of cases) {
            let envelope = item.envelope;
            if (item.idByteLength !== undefined) {
                const id = "a".repeat(item.idByteLength);
                document.body.innerHTML = `<main id="${id}"></main>`;
                envelope = `<graft-patch-set version="1"><graft-patch operation="children" target="${id}"><template><p>Ready</p></template></graft-patch></graft-patch-set>`;
            } else {
                document.body.innerHTML =
                    item.initialDocument ?? '<main id="fixture-target"></main>';
            }
            if (item.keyInput !== undefined) {
                const key =
                    typeof item.keyInput === "string"
                        ? item.keyInput
                        : item.keyInput.prefix +
                          item.keyInput.repeat.repeat(item.keyInput.count);
                const phase =
                    consumer === "browser-preflight-frame"
                        ? ' phase="final"'
                        : "";
                envelope = `<graft-patch-set version="1"${phase}><graft-patch operation="children" target="fixture-target"><template><i id="valid" data-graft-key="${key}"></i></template></graft-patch></graft-patch-set>`;
            }
            expect(envelope, item.name).toBeTypeOf("string");
            const run = () => {
                if (consumer === "browser-preflight")
                    return preflight(response(envelope!)[0], envelope!);
                if (consumer === "browser-preflight-live")
                    return preflightLive(envelope!);
                return preflightFrame(envelope!);
            };
            if (item.expectation === "accept") {
                expect(run, item.name).not.toThrow();
            } else {
                expect(run, item.name).toThrowError(
                    expect.objectContaining({
                        reason: item.browserReason ?? item.expectation,
                    }),
                );
            }
        }
    }
    expect(count).toBeGreaterThan(0);
});

test("preflights and applies a children batch", () => {
    const [reply, text] = response(
        '<graft-patch-set version="1" title="Patients"><graft-patch operation="children" target="patient-results"><template><p id="new">New</p></template></graft-patch></graft-patch-set>',
    );
    const prepared = preflight(reply, text);
    expect(prepared.kind).toBe("patches");
    if (prepared.kind === "patches") apply(prepared.batch);
    expect(document.querySelector("#patient-results")?.textContent).toBe("New");
    expect(document.title).toBe("Patients");
});

test("applies trusted web-platform markup with browser-created namespaces", () => {
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template><article id="semantic"><header>Summary</header><svg id="diagram" viewBox="0 0 20 20"><defs><linearGradient id="paint"><stop offset="0" stop-color="red"></stop></linearGradient></defs><use href="#shape"></use><path id="shape" d="M1 1 C 2 3, 4 5, 6 7" fill="url(#paint)"></path><foreignObject><p id="foreign-html">HTML</p></foreignObject></svg><math id="formula"><mrow><mi>x</mi><mo>=</mo><mn>1</mn></mrow></math><practice-status id="custom" data-state="ready">Ready</practice-status></article></template></graft-patch></graft-patch-set>`;
    const prepared = preflight(response(text)[0], text);
    if (prepared.kind === "patches") apply(prepared.batch);

    expect(document.getElementById("semantic")?.namespaceURI).toBe(
        "http://www.w3.org/1999/xhtml",
    );
    expect(document.getElementById("diagram")?.namespaceURI).toBe(
        "http://www.w3.org/2000/svg",
    );
    expect(document.getElementById("shape")?.getAttribute("d")).toContain(
        "C 2 3",
    );
    const parserMathNamespace = new DOMParser()
        .parseFromString('<math id="expected-math"></math>', "text/html")
        .getElementById("expected-math")?.namespaceURI;
    expect(document.getElementById("formula")?.namespaceURI).toBe(
        parserMathNamespace,
    );
    expect(document.getElementById("custom")?.localName).toBe(
        "practice-status",
    );
});

test("does not second-guess web-platform attributes or resource references", () => {
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template><svg id="resource-svg"><image href="https://cdn.example.test/image.svg" crossorigin="anonymous"></image></svg><math id="resource-math" mathbackground="red"><annotation encoding="text/html">value</annotation></math><a id="local-resource" href="/patients?next=1" style="color: red" onclick="return false">Local</a></template></graft-patch></graft-patch-set>`;
    const prepared = preflight(response(text)[0], text);
    if (prepared.kind === "patches") apply(prepared.batch);
    expect(
        document.getElementById("local-resource")?.getAttribute("onclick"),
    ).toBe("return false");
    expect(document.querySelector("image")?.getAttribute("href")).toBe(
        "https://cdn.example.test/image.svg",
    );
});

test("supports nested application templates without confusing the envelope", () => {
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template><section id="holder"><template id="application-template"><p id="future-content">Later</p></template></section></template></graft-patch></graft-patch-set>`;
    const prepared = preflight(response(text)[0], text);
    if (prepared.kind === "patches") apply(prepared.batch);
    const nested = document.getElementById(
        "application-template",
    ) as HTMLTemplateElement;
    expect(nested.content.getElementById("future-content")?.textContent).toBe(
        "Later",
    );
});

test("moves an appointment between retained practitioner layers authoritatively", () => {
    document.body.innerHTML = `
      <main id="main"><div id="diary-grid" data-stable="grid">
        <section id="diary-column-appointments-dr-1" data-stable="source"><article id="diary-appointment-a1" data-lane="0" data-lanes="1">Old</article></section>
        <section id="diary-column-appointments-dr-2" data-stable="destination"><article id="diary-appointment-b1">Stationary</article></section>
      </div><div id="appointment-actions-identity"></div><div id="appointment-actions-feedback"></div></main>`;
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="diary-column-appointments-dr-1"><template><article id="diary-appointment-c1" data-lane="0" data-lanes="1">Source truth</article></template></graft-patch><graft-patch operation="children" target="diary-column-appointments-dr-2"><template><article id="diary-appointment-b1" data-lane="0" data-lanes="2">Stationary</article><article id="diary-appointment-a1" data-practitioner="dr-2" data-start-minutes="600" data-lane="1" data-lanes="2">Moved</article></template></graft-patch><graft-patch operation="children" target="appointment-actions-identity"><template><p>Moved identity</p></template></graft-patch><graft-patch operation="children" target="appointment-actions-feedback"><template><p>Appointment moved.</p></template></graft-patch></graft-patch-set>`;
    const prepared = preflight(response(text)[0], text);
    expect(prepared.kind).toBe("patches");
    if (prepared.kind === "patches") apply(prepared.batch);

    expect(document.getElementById("diary-grid")?.dataset.stable).toBe("grid");
    expect(
        document.getElementById("diary-column-appointments-dr-1")?.dataset
            .stable,
    ).toBe("source");
    expect(
        document.getElementById("diary-column-appointments-dr-2")?.dataset
            .stable,
    ).toBe("destination");
    const moved = document.getElementById("diary-appointment-a1")!;
    expect(moved.closest("section")?.id).toBe("diary-column-appointments-dr-2");
    expect(moved.dataset).toMatchObject({
        practitioner: "dr-2",
        startMinutes: "600",
        lane: "1",
        lanes: "2",
    });
});

test.each([
    ["missing destination", "missing-layer"],
    ["invalid later action target", "missing-actions"],
])("an %s changes no move target", (_name, invalidTarget) => {
    document.body.innerHTML = `<main id="main"><section id="source"><article id="diary-appointment-a1">Old</article></section><section id="destination"></section><div id="actions"></div></main>`;
    const before = document.body.innerHTML;
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="source"><template></template></graft-patch><graft-patch operation="children" target="destination"><template><article id="diary-appointment-a1">Moved</article></template></graft-patch><graft-patch operation="children" target="${invalidTarget}"><template>Invalid</template></graft-patch></graft-patch-set>`;
    expect(() => preflight(response(text)[0], text)).toThrow();
    expect(document.body.innerHTML).toBe(before);
});

test("rejects a move while a duplicate-ID ghost survives outside its targets", () => {
    document.body.innerHTML = `<main id="main"><section id="source"><article id="diary-appointment-a1">Old</article></section><section id="destination"></section></main><article id="diary-appointment-a1" data-drag-ghost>Ghost</article>`;
    const before = document.body.innerHTML;
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="source"><template></template></graft-patch><graft-patch operation="children" target="destination"><template><article id="diary-appointment-a1">Moved</article></template></graft-patch></graft-patch-set>`;
    expect(() => preflight(response(text)[0], text)).toThrow();
    expect(document.body.innerHTML).toBe(before);
});

test("preflights all three status targets atomically and preserves roots", () => {
    document.body.innerHTML = `<form id="status-form"><span id="appointment-status-controls" data-stable="controls"><button id="appointment-status-arrived">Old</button></span></form><div id="appointment-status-feedback" aria-live="polite"></div><article id="diary-appointment-a1" aria-pressed="true" data-geometry="stable"><span>Old card</span></article>`;
    document.getElementById("appointment-status-arrived")!.focus();
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="appointment-status-controls"><template><input name="expected_status" value="arrived"><button id="appointment-status-arrived">Checked in</button></template></graft-patch><graft-patch operation="children" target="appointment-status-feedback"><template><p>Updated</p></template></graft-patch><graft-patch operation="children" target="diary-appointment-a1"><template><span data-status-value="arrived">New card</span></template></graft-patch></graft-patch-set>`;
    const prepared = preflight(response(text, 409)[0], text);
    if (prepared.kind === "patches") apply(prepared.batch);
    expect(
        document.getElementById("appointment-status-controls")?.dataset.stable,
    ).toBe("controls");
    expect(
        document
            .getElementById("diary-appointment-a1")
            ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
        document.getElementById("diary-appointment-a1")?.dataset.geometry,
    ).toBe("stable");
    expect(document.activeElement?.id).toBe("appointment-status-arrived");
});

test.each([
    `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template><p>first</p></template></graft-patch><graft-patch operation="children" target="main"><template><p>second</p></template></graft-patch><graft-patch operation="children" target="missing"><template><p>third</p></template></graft-patch></graft-patch-set>`,
    `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template><p>first</p></template></graft-patch><graft-patch operation="children" target="main"><template><p>second</p></template></graft-patch><graft-patch operation="children" target="old"><template><script>bad</script></template></graft-patch></graft-patch-set>`,
])("an invalid third status patch changes no earlier target", (text) => {
    const before = document.body.innerHTML;
    expect(() => preflight(response(text)[0], text)).toThrow();
    expect(document.body.innerHTML).toBe(before);
});

test.each([
    ["<script>bad()</script>", "script element"],
    [
        '<i data-graft-key="private-invalid-value"></i>',
        "invalid reconciliation metadata",
    ],
    [
        '<i data-graft-key="u:aa"></i><i data-graft-key="u:aa"></i>',
        "invalid reconciliation metadata",
    ],
])("rejects invalid later content atomically: %s", (content, message) => {
    document.body.innerHTML =
        '<main id="main"><div id="first-target">First</div><div id="second-target">Second</div></main>';
    const before = document.body.innerHTML;
    const text = `<graft-patch-set version="1" title="Changed"><graft-patch operation="children" target="first-target"><template><p id="valid-first">Valid</p></template></graft-patch><graft-patch operation="children" target="second-target"><template>${content}</template></graft-patch></graft-patch-set>`;
    expect(() => preflight(response(text)[0], text)).toThrowError(
        expect.objectContaining({
            reason: "target-content",
            message: `Invalid Hypergraft response: ${message}`,
            targetId: "second-target",
        }),
    );
    expect(document.body.innerHTML).toBe(before);
    expect(document.title).toBe("Before");
});

test("retains bounds and ID guarantees across mixed namespaces", () => {
    const invalidId = `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template><svg><path id="not valid"></path></svg></template></graft-patch></graft-patch-set>`;
    expect(() => preflight(response(invalidId)[0], invalidId)).toThrow(
        "invalid ID",
    );

    const duplicateId = `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template><svg><path id="mixed-id"></path></svg><math><mi id="mixed-id">x</mi></math></template></graft-patch></graft-patch-set>`;
    expect(() => preflight(response(duplicateId)[0], duplicateId)).toThrow(
        "duplicate inserted ID",
    );

    const deep = `${"<svg>".repeat(65)}${"</svg>".repeat(65)}`;
    const deepText = `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template>${deep}</template></graft-patch></graft-patch-set>`;
    expect(() => preflight(response(deepText)[0], deepText)).toThrow(
        "depth bound exceeded",
    );
});

test("rejects content above the node budget", () => {
    // A virtual sibling list exercises the full budget without a million DOM allocations.
    const fragment = document.createDocumentFragment();
    const node = document.createTextNode("x");
    Object.defineProperty(fragment, "childNodes", {
        value: {
            *[Symbol.iterator]() {
                for (let i = 0; i <= MAX_INSERTED_NODES; i++) yield node;
            },
        },
    });
    const clone = vi
        .spyOn(DocumentFragment.prototype, "cloneNode")
        .mockReturnValueOnce(fragment);
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template></template></graft-patch></graft-patch-set>`;
    try {
        expect(() => preflight(response(text)[0], text)).toThrow(
            "node bound exceeded",
        );
    } finally {
        clone.mockRestore();
    }
});

test("rejects responses above the byte bound before parsing", () => {
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template>${"x".repeat(MAX_RESPONSE_BYTES)}</template></graft-patch></graft-patch-set>`;
    expect(() => preflight(response(text)[0], text)).toThrow(
        "size bound exceeded",
    );
});

test("accepts large HTML within the content budgets", () => {
    const content = `<p>${"&amp;".repeat(400_000)}</p>${"<p>Row</p>".repeat(20_000)}`;
    const text = `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template>${content}</template></graft-patch></graft-patch-set>`;
    expect(preflight(response(text)[0], text).kind).toBe("patches");
});

test("prepares a same-origin full navigation", () => {
    const [reply, text] = response(
        '<graft-patch-set version="1" navigate="/dashboard/account/preferences?theme=updated"></graft-patch-set>',
    );

    expect(preflight(reply, text)).toEqual({
        kind: "navigation",
        destination:
            "http://localhost:3000/dashboard/account/preferences?theme=updated",
    });
});

test.each(PATCH_STATUSES)("accepts patch status %i", (status) => {
    const text =
        '<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template>x</template></graft-patch></graft-patch-set>';
    expect(preflight(response(text, status)[0], text).kind).toBe("patches");
});

test.each([null, "", "0", "-1", "+1", "tomorrow"])(
    "rejects a 429 with invalid Retry-After %s",
    (retryAfter) => {
        const text =
            '<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template>x</template></graft-patch></graft-patch-set>';
        const headers: Record<string, string> = { "content-type": MEDIA_TYPE };
        if (retryAfter !== null) headers["retry-after"] = retryAfter;
        const reply = new Response(text, { status: 429, headers });
        expect(() => preflight(reply, text)).toThrow("retry-after");
    },
);

test.each([201, 400, 404, 500])("rejects unsupported status %i", (status) => {
    const text =
        '<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template>x</template></graft-patch></graft-patch-set>';
    expect(() => preflight(response(text, status)[0], text)).toThrow();
});

test.each([409, 429])(
    "rejects a navigation envelope at patch-only status %i",
    (status) => {
        const text =
            '<graft-patch-set version="1" navigate="/diary"></graft-patch-set>';
        expect(() => preflight(response(text, status)[0], text)).toThrow();
    },
);

test.each([
    '<graft-patch-set version="2"><graft-patch operation="children" target="main"><template>x</template></graft-patch></graft-patch-set>',
    '<graft-patch-set version="1"><graft-patch operation="replace" target="main"><template>x</template></graft-patch></graft-patch-set>',
    '<graft-patch-set version="1"><graft-patch operation="children" target="missing"><template>x</template></graft-patch></graft-patch-set>',
    '<graft-patch-set version="1"><graft-patch operation="children" target="main"><template><script>alert(1)</script></template></graft-patch></graft-patch-set>',
    '<graft-patch-set version="1"><graft-patch operation="children" target="main"><template><template><script>alert(1)</script></template></template></graft-patch></graft-patch-set>',
    '<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template><p id="main">collision</p></template></graft-patch></graft-patch-set>',
    '<graft-patch-set version="1" navigate="/next" title="Next"></graft-patch-set>',
    '<graft-patch-set version="1" navigate="/next" location="/other"></graft-patch-set>',
    '<graft-patch-set version="1" navigate="/next"><graft-patch operation="children" target="main"><template>x</template></graft-patch></graft-patch-set>',
    '<graft-patch-set version="1" location="https://example.test/next"><graft-patch operation="children" target="main"><template>x</template></graft-patch></graft-patch-set>',
    '<graft-patch-set version="1" location="/next#fragment"><graft-patch operation="children" target="main"><template>x</template></graft-patch></graft-patch-set>',
    '<graft-patch-set version="1"></graft-patch-set>',
    '<graft-patch-set version="1" navigate=""></graft-patch-set>',
    '<graft-patch-set version="1" navigate="https://example.test/next"></graft-patch-set>',
    '<graft-patch-set version="1" navigate="//example.test/next"></graft-patch-set>',
    '<graft-patch-set version="1" navigate="/bad\\path"></graft-patch-set>',
    '<graft-patch-set version="1" navigate="/next#fragment"></graft-patch-set>',
    '<graft-patch-set version="1" navigate="/next\u0001"></graft-patch-set>',
    '<graft-patch-set version="1" navigate="/next"><!-- comment --></graft-patch-set>',
    '<graft-patch-set version="1" navigate="/next">content</graft-patch-set>',
])(
    "rejects malformed or unsafe batches without changing the document",
    (text) => {
        const before = document.body.innerHTML;
        expect(() => preflight(response(text)[0], text)).toThrow();
        expect(document.body.innerHTML).toBe(before);
        expect(document.title).toBe("Before");
    },
);

test("a rejected navigation changes no browser state", () => {
    const text =
        '<graft-patch-set version="1" navigate="https://example.test/next"></graft-patch-set>';
    const before = {
        body: document.body.innerHTML,
        title: document.title,
        href: location.href,
        historyLength: history.length,
    };

    expect(() => preflight(response(text)[0], text)).toThrow();
    expect(document.body.innerHTML).toBe(before.body);
    expect(document.title).toBe(before.title);
    expect(location.href).toBe(before.href);
    expect(history.length).toBe(before.historyLength);
});

test("appends preflighted nodes without replacing existing children", () => {
    const text =
        '<graft-patch-set version="1"><graft-patch operation="append" target="patient-results"><template><p id="new">New</p></template></graft-patch></graft-patch-set>';
    const prepared = preflight(response(text)[0], text);
    if (prepared.kind === "patches") apply(prepared.batch);
    expect(document.getElementById("old")?.textContent).toBe("Old");
    expect(document.getElementById("new")?.textContent).toBe("New");
});

test("rejects an append that duplicates a surviving descendant ID", () => {
    const text =
        '<graft-patch-set version="1"><graft-patch operation="append" target="patient-results"><template><p id="old">Duplicate</p></template></graft-patch></graft-patch-set>';
    expect(() => preflight(response(text)[0], text)).toThrow(
        expect.objectContaining({ reason: "target-content" }),
    );
});

test("preflights a representative stream frame", () => {
    const framed = fixture.representativeStreamFrame;
    const newline = framed.indexOf("\n");
    const length = Number(framed.slice(0, newline));
    const envelope = framed.slice(newline + 1);
    expect(new TextEncoder().encode(envelope).length).toBe(length);
    document.body.innerHTML = '<main id="fixture-target"></main>';
    const prepared = preflightFrame(envelope);
    expect(prepared.phase).toBe("progress");
    apply(prepared.batch);
    expect(document.querySelector("#fixture-target")?.textContent).toBe(
        "Ready",
    );
});

test("rejects a stream frame without a phase", () => {
    const text =
        '<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template>x</template></graft-patch></graft-patch-set>';
    expect(() => preflightFrame(text)).toThrow("phase");
});

test("rejects a progress frame that carries a status", () => {
    const text =
        '<graft-patch-set version="1" phase="progress" status="200"><graft-patch operation="children" target="patient-results"><template>x</template></graft-patch></graft-patch-set>';
    expect(() => preflightFrame(text)).toThrow();
});

test("rejects a non-canonical final status", () => {
    const text =
        '<graft-patch-set version="1" phase="final" status="0200"><graft-patch operation="children" target="patient-results"><template>x</template></graft-patch></graft-patch-set>';
    expect(() => preflightFrame(text)).toThrow("status");
});

test.each([
    [
        "current native template duplicates",
        '<template><i data-graft-key="u:aa"></i><i data-graft-key="u:aa"></i></template>',
        "",
        "children",
        false,
    ],
    [
        "separate native template scopes",
        "",
        '<template><i data-graft-key="u:aa"></i></template><template><i data-graft-key="u:aa"></i></template>',
        "children",
        true,
    ],
    [
        "mixed namespace siblings",
        "",
        '<i data-graft-key="u:aa"></i><svg data-graft-key="u:aa"></svg><math></math>',
        "children",
        false,
    ],
    [
        "marker and ID domains",
        "",
        '<i data-graft-key="u:aa"></i><i id="u:aa"></i>',
        "children",
        true,
    ],
    [
        "marker precedence over ID",
        "",
        '<i id="u:aa" data-graft-key="u:bb"></i><i data-graft-key="u:aa"></i>',
        "children",
        true,
    ],
    [
        "independent ID validation",
        '<i id="outside"></i>',
        '<i id="outside" data-graft-key="u:aa"></i>',
        "append",
        false,
    ],
    [
        "append descendant key reuse",
        '<div><i data-graft-key="u:aa"></i></div>',
        '<i data-graft-key="u:aa"></i>',
        "append",
        true,
    ],
    [
        "malformed current marker",
        '<i id="valid" data-graft-key="bad"></i>',
        "",
        "children",
        false,
    ],
] as const)(
    "validates sibling scopes: %s",
    (_name, current, incoming, operation, accepted) => {
        document.body.innerHTML = `<main id="fixture-target">${current}</main>`;
        for (const mode of ["complete", "frame", "live"]) {
            const phase = mode === "frame" ? ' phase="final"' : "";
            const text = `<graft-patch-set version="1"${phase}><graft-patch operation="${operation}" target="fixture-target"><template>${incoming}</template></graft-patch></graft-patch-set>`;
            const run = () =>
                mode === "complete"
                    ? preflight(response(text)[0], text)
                    : mode === "frame"
                      ? preflightFrame(text)
                      : preflightLive(text);
            if (accepted) expect(run).not.toThrow();
            else
                expect(run).toThrowError(
                    expect.objectContaining({ reason: "target-content" }),
                );
        }
    },
);

test("current depth does not consume the incoming depth bound", () => {
    const target = document.getElementById("patient-results")!;
    let parent = target;
    for (let i = 0; i < MAX_NESTING_DEPTH * 2; i++)
        parent = parent.appendChild(document.createElement("div"));
    const text =
        '<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template></template></graft-patch></graft-patch-set>';
    expect(() => preflight(response(text)[0], text)).not.toThrow();
    parent.setAttribute("data-graft-key", "bad");
    expect(() => preflight(response(text)[0], text)).toThrow(
        "invalid reconciliation metadata",
    );
});

test.each(["<script></script>", "<div>".repeat(MAX_NESTING_DEPTH + 1)])(
    "inspects content before the host callback: %s",
    (content) => {
        const callback = vi.fn();
        const text = `<graft-patch-set version="1"><graft-patch operation="children" target="patient-results"><template>${content}</template></graft-patch></graft-patch-set>`;
        expect(() =>
            preflight(response(text)[0], text, document, callback),
        ).toThrowError(expect.objectContaining({ reason: "target-content" }));
        expect(callback).not.toHaveBeenCalled();
    },
);

test("applies the final fragment roots after host callbacks", () => {
    document.body.innerHTML = '<main id="a"></main><aside id="b"></aside>';
    const text =
        '<graft-patch-set version="1"><graft-patch operation="children" target="a"><template>Original</template></graft-patch><graft-patch operation="children" target="b"><template></template></graft-patch></graft-patch-set>';
    let first: DocumentFragment | undefined;
    const replacement = document.createElement("p");
    replacement.textContent = "Final";
    replacement.setAttribute("data-graft-key", "u:aa");
    const callback = vi.fn((fragment: DocumentFragment) => {
        if (!first) first = fragment;
        else first.replaceChildren(replacement);
    });
    const prepared = preflight(response(text)[0], text, document, callback);
    if (prepared.kind === "patches") apply(prepared.batch);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(document.getElementById("a")!.textContent).toBe("Final");
    expect(
        document.querySelector("#a > p")!.getAttribute("data-graft-key"),
    ).toBe("u:aa");
});

test.each(["key", "script", "id", "depth", "duplicate"])(
    "reinspects earlier fragments after callbacks: %s",
    (kind) => {
        document.body.innerHTML =
            '<main id="a">Before</main><aside id="b">Before</aside>';
        const text =
            '<graft-patch-set version="1" title="After"><graft-patch operation="children" target="a"><template><p>Ready</p></template></graft-patch><graft-patch operation="children" target="b"><template><p>Ready</p></template></graft-patch></graft-patch-set>';
        let first: DocumentFragment;
        const callback = vi.fn((fragment: DocumentFragment) => {
            if (!first) {
                first = fragment;
                return;
            }
            if (kind === "script")
                first.append(document.createElement("script"));
            else if (kind === "depth") {
                let parent: Node = first;
                for (let i = 0; i <= MAX_NESTING_DEPTH; i++)
                    parent = parent.appendChild(document.createElement("div"));
            } else if (kind === "duplicate") {
                first.firstElementChild!.setAttribute("data-graft-key", "u:aa");
                first.append(first.firstElementChild!.cloneNode(true));
            } else
                first.firstElementChild!.setAttribute(
                    kind === "key" ? "data-graft-key" : "id",
                    "!",
                );
        });
        expect(() =>
            preflight(response(text)[0], text, document, callback),
        ).toThrowError(expect.objectContaining({ reason: "target-content" }));
        expect(callback).toHaveBeenCalledTimes(2);
        expect(document.getElementById("a")!.textContent).toBe("Before");
        expect(document.getElementById("b")!.textContent).toBe("Before");
        expect(document.title).toBe("Before");
    },
);
