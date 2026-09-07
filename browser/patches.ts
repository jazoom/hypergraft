import { HypergraftError } from "./diagnostics";
import { appendChildren, morphChildren } from "./morph";

export const PROTOCOL_VERSION = "1";
export const MEDIA_TYPE = "text/vnd.hypergraft.patches+html";
export const GRAFT_TRANSFER = "Graft-Transfer";
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_PATCHES = 16;
export const MAX_INSERTED_NODES = 10000;
export const MAX_NESTING_DEPTH = 64;
export const MAX_STREAM_FRAMES = 256;
export const MAX_STREAM_BYTES = 16 * 1024 * 1024;
export const ID_PATTERN_SOURCE = "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$";
const ID_PATTERN = new RegExp(ID_PATTERN_SOURCE);
export const PATCH_STATUSES = [200, 401, 409, 422, 429] as const;
export const STREAM_STATUSES = [200, 401, 409, 422] as const;
export type AcceptedPatchStatus = (typeof PATCH_STATUSES)[number];
export type StreamStatus = (typeof STREAM_STATUSES)[number];
export const NAVIGATION_STATUS = 200;
export const OPERATIONS = ["children", "append"] as const;
export type PatchOperation = (typeof OPERATIONS)[number];
export const PHASES = ["progress", "final"] as const;
export type PatchPhase = (typeof PHASES)[number];

type TrustedPolicy = { createHTML(value: string): unknown };
type TrustedTypePolicyFactory = {
    createPolicy(
        name: string,
        rules: { createHTML(value: string): string },
    ): TrustedPolicy;
};

export const TRUSTED_TYPES_POLICY_NAME = "hypergraft";
// Cached only after a successful createPolicy in this module instance. The
// private passthrough grants access to the HTML parsing sink. It does not
// sanitise application markup, and imports must not create the policy.
let policy: TrustedPolicy | undefined;

function trustedTypeFactory(): TrustedTypePolicyFactory | undefined {
    return (
        globalThis as typeof globalThis & {
            trustedTypes?: TrustedTypePolicyFactory;
        }
    ).trustedTypes;
}

export type ValidateContent = (fragment: DocumentFragment) => void;

export type PreparedPatch = {
    target: HTMLElement;
    targetId: string;
    operation: PatchOperation;
    nodes: Node[];
};

export type PreparedBatch = {
    title?: string;
    replaceLocation?: string;
    patches: PreparedPatch[];
};

export type PreparedResponse =
    | { kind: "patches"; batch: PreparedBatch }
    | { kind: "navigation"; destination: string };

export type PreparedFrame =
    | { phase: "progress"; batch: PreparedBatch }
    | { phase: "final"; status: StreamStatus; batch: PreparedBatch };

function fail(
    reason: HypergraftError["reason"],
    message: string,
    targetId?: string,
): never {
    throw new HypergraftError(
        reason,
        `Invalid Hypergraft response: ${message}`,
        targetId,
    );
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
function htmlForParser(text: string): string {
    const factory = trustedTypeFactory();
    if (!factory) return text;
    if (!policy) {
        policy = factory.createPolicy(TRUSTED_TYPES_POLICY_NAME, {
            createHTML: (value) => value,
        });
    }
    return policy.createHTML(text) as string;
}
function attributes(element: Element, allowed: Set<string>) {
    for (const attribute of element.attributes)
        if (!allowed.has(attribute.name))
            fail("protocol", `unknown ${element.localName} attribute`);
}
function whitespaceChildren(element: Element, expected: string): Element[] {
    const result: Element[] = [];
    for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
            continue;
        if (
            node.nodeType !== Node.ELEMENT_NODE ||
            (node as Element).localName !== expected
        )
            fail("protocol", `unknown ${element.localName} child`);
        result.push(node as Element);
    }
    return result;
}
function inspectContent(
    fragment: DocumentFragment,
    targetId: string,
    validateContent?: ValidateContent,
): {
    ids: string[];
    count: number;
} {
    const ids: string[] = [];
    let count = 0;
    const walk = (node: Node, depth: number) => {
        if (++count > MAX_INSERTED_NODES)
            fail("target-content", "node bound exceeded", targetId);
        if (depth > MAX_NESTING_DEPTH)
            fail("target-content", "depth bound exceeded", targetId);
        if (node.nodeType !== Node.ELEMENT_NODE) {
            for (const child of node.childNodes) walk(child, depth + 1);
            return;
        }
        const element = node as Element;
        if (element.localName.toLowerCase() === "script")
            fail("target-content", "script element", targetId);
        if (element.id) {
            if (!ID_PATTERN.test(element.id))
                fail("target-content", "invalid ID", targetId);
            ids.push(element.id);
        }
        for (const child of element.childNodes) walk(child, depth + 1);
        if (element instanceof HTMLTemplateElement)
            for (const child of element.content.childNodes)
                walk(child, depth + 1);
    };
    for (const child of fragment.childNodes) walk(child, 1);
    try {
        validateContent?.(fragment);
    } catch (error) {
        fail(
            "target-content",
            `content validation failed: ${errorMessage(error)}`,
            targetId,
        );
    }
    return { ids, count };
}

function navigationDestination(value: string): string {
    if (
        !/^\/(?!\/)/.test(value) ||
        /[^\x20-\x7e]/.test(value) ||
        value.includes("\\") ||
        value.includes("#")
    )
        fail("protocol", "navigation destination");
    const destination = new URL(value, location.origin);
    if (
        destination.origin !== location.origin ||
        destination.username ||
        destination.password
    )
        fail("protocol", "navigation destination");
    return destination.href;
}

export function transferKind(response: Response): "complete" | "stream" {
    const value = response.headers.get(GRAFT_TRANSFER);
    if (value === null || value === "complete") return "complete";
    if (value === "stream") return "stream";
    fail("protocol", "transfer");
}

export function preflight(
    response: Response,
    text: string,
    liveDocument: Document = document,
    validateContent?: ValidateContent,
): PreparedResponse {
    if (transferKind(response) !== "complete") fail("protocol", "transfer");
    if (!(PATCH_STATUSES as readonly number[]).includes(response.status))
        fail("protocol", "status");
    if (
        response.status === 429 &&
        !/^[1-9][0-9]*$/.test(response.headers.get("retry-after") ?? "")
    )
        fail("protocol", "retry-after");
    if (response.headers.get("content-type") !== MEDIA_TYPE)
        fail("protocol", "media type");
    const prepared = parseEnvelope(
        text,
        liveDocument,
        validateContent,
        "complete",
    );
    if (prepared.kind === "navigation" && response.status !== NAVIGATION_STATUS)
        fail("protocol", "navigation envelope");
    return prepared;
}

export function preflightFrame(
    text: string,
    liveDocument: Document = document,
    validateContent?: ValidateContent,
): PreparedFrame {
    const prepared = parseEnvelope(
        text,
        liveDocument,
        validateContent,
        "stream",
    );
    if (prepared.kind === "navigation") fail("protocol", "stream navigation");
    const phase = prepared.phase;
    if (phase === "progress") {
        if (prepared.status !== undefined) fail("protocol", "progress status");
        return { phase, batch: prepared.batch };
    }
    return {
        phase: "final",
        status: prepared.status ?? 200,
        batch: prepared.batch,
    };
}

export function preflightLive(
    text: string,
    liveDocument: Document = document,
    validateContent?: ValidateContent,
): PreparedBatch {
    const prepared = parseEnvelope(text, liveDocument, validateContent, "live");
    if (prepared.kind === "navigation") fail("protocol", "live navigation");
    return prepared.batch;
}

function parseEnvelope(
    text: string,
    liveDocument: Document,
    validateContent: ValidateContent | undefined,
    mode: "complete" | "stream" | "live",
): PreparedResponse & { phase?: PatchPhase; status?: StreamStatus } {
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES)
        fail("byte-limit", "size bound exceeded");
    const parser = new DOMParser();
    let parsed: Document;
    try {
        parsed = parser.parseFromString(htmlForParser(text), "text/html");
    } catch (error) {
        fail("protocol", `unable to parse response: ${errorMessage(error)}`);
    }
    if (
        parsed.body.children.length !== 1 ||
        [...parsed.body.childNodes].some(
            (n) =>
                n.nodeType === Node.COMMENT_NODE ||
                (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()),
        )
    )
        fail("protocol", "top-level grammar");
    const set = parsed.body.firstElementChild!;
    if (set.localName !== "graft-patch-set") fail("protocol", "envelope");
    attributes(
        set,
        mode === "stream"
            ? new Set(["version", "title", "phase", "status"])
            : mode === "live"
              ? new Set(["version"])
              : new Set(["version", "title", "navigate", "location"]),
    );
    if (set.getAttribute("version") !== PROTOCOL_VERSION)
        fail("protocol", "version");
    if (set.hasAttribute("navigate")) {
        if (set.hasAttribute("title") || set.hasAttribute("location"))
            fail("protocol", "navigation envelope");
        for (const node of set.childNodes)
            if (node.nodeType !== Node.TEXT_NODE || node.textContent?.trim())
                fail("protocol", "navigation child");
        return {
            kind: "navigation",
            destination: navigationDestination(set.getAttribute("navigate")!),
        };
    }
    let phase: PatchPhase | undefined;
    let status: StreamStatus | undefined;
    if (mode === "stream") {
        const rawPhase = set.getAttribute("phase");
        if (!(PHASES as readonly string[]).includes(rawPhase ?? ""))
            fail("protocol", "phase");
        phase = rawPhase as PatchPhase;
        if (set.hasAttribute("status")) {
            if (phase !== "final") fail("protocol", "progress status");
            const rawStatus = set.getAttribute("status")!;
            if (
                !(STREAM_STATUSES as readonly number[]).some(
                    (accepted) => String(accepted) === rawStatus,
                )
            )
                fail("protocol", "status");
            status = Number(rawStatus) as StreamStatus;
        }
    }
    const patchElements = whitespaceChildren(set, "graft-patch");
    if (!patchElements.length || patchElements.length > MAX_PATCHES)
        fail("protocol", "patch count");
    const targetIds = new Set<string>();
    const insertionIds = new Set<string>();
    const patches: PreparedBatch["patches"] = [];
    let nodeCount = 0;
    for (const patch of patchElements) {
        attributes(patch, new Set(["operation", "target"]));
        const operation = patch.getAttribute("operation") ?? "";
        if (!(OPERATIONS as readonly string[]).includes(operation))
            fail("protocol", "operation");
        const id = patch.getAttribute("target") ?? "";
        if (!ID_PATTERN.test(id)) fail("target-content", "target");
        if (targetIds.has(id)) fail("target-content", "duplicate target", id);
        const targets = liveDocument.querySelectorAll(
            `[id="${CSS.escape(id)}"]`,
        );
        if (targets.length !== 1)
            fail("target-content", "missing or duplicate target", id);
        const target = targets[0] as HTMLElement;
        for (const previous of patches)
            if (
                previous.target.contains(target) ||
                target.contains(previous.target)
            )
                fail("target-content", "overlapping targets", id);
        targetIds.add(id);
        const children = whitespaceChildren(patch, "template");
        if (children.length !== 1) fail("protocol", "template count", id);
        const template = children[0] as HTMLTemplateElement;
        if (template.attributes.length)
            fail("protocol", "template attributes", id);
        const clone = template.content.cloneNode(true) as DocumentFragment;
        const inspected = inspectContent(clone, id, validateContent);
        nodeCount += inspected.count;
        if (nodeCount > MAX_INSERTED_NODES)
            fail("target-content", "node bound exceeded", id);
        for (const insertedId of inspected.ids) {
            if (insertionIds.has(insertedId))
                fail("target-content", "duplicate inserted ID", id);
            insertionIds.add(insertedId);
        }
        patches.push({
            target,
            targetId: id,
            operation: operation as PatchOperation,
            nodes: [...clone.childNodes],
        });
    }
    const survivingIds = new Set<string>();
    for (const element of liveDocument.querySelectorAll("[id]")) {
        if (
            patches.some(
                (p) =>
                    p.operation === "children" &&
                    p.target.contains(element) &&
                    p.target !== element,
            )
        )
            continue;
        if (
            !ID_PATTERN.test(element.id) ||
            survivingIds.has(element.id) ||
            insertionIds.has(element.id)
        )
            fail("target-content", "final ID collision");
        survivingIds.add(element.id);
    }
    return {
        kind: "patches",
        batch: {
            title: set.hasAttribute("title")
                ? set.getAttribute("title")!
                : undefined,
            replaceLocation: set.hasAttribute("location")
                ? navigationDestination(set.getAttribute("location")!)
                : undefined,
            patches,
        },
        phase,
        status,
    };
}

export function apply(
    batch: PreparedBatch,
    // Cleanup consumes this immediately. Morphlex can leave an authored
    // disabled value identical to the pending overlay, so ownership cannot
    // be inferred from the live DOM after apply.
    consumeOwned?: (element: Element) => void,
) {
    const active = document.activeElement as
        HTMLInputElement | HTMLTextAreaElement | null;
    const focusId = active?.id;
    const start = active?.selectionStart;
    const end = active?.selectionEnd;
    for (const patch of batch.patches) {
        if (patch.operation === "append")
            appendChildren(patch.target, patch.nodes);
        else morphChildren(patch.target, patch.nodes, consumeOwned);
    }
    if (batch.title !== undefined) document.title = batch.title;
    if (focusId) {
        const finalControl = document.getElementById(focusId) as
            HTMLInputElement | HTMLTextAreaElement | null;
        finalControl?.focus({ preventScroll: true });
        if (
            finalControl &&
            start !== null &&
            start !== undefined &&
            end !== null &&
            end !== undefined
        )
            try {
                const length = finalControl.value.length;
                finalControl.setSelectionRange(
                    Math.min(start, length),
                    Math.min(end, length),
                );
            } catch {
                /* Not a text control. */
            }
    }
}
