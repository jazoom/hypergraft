import { HypergraftError } from "./diagnostics";
import { morphChildren } from "./morph";

export const PROTOCOL_VERSION = "1";
export const MEDIA_TYPE = "text/vnd.hypergraft.patches+html";
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_PATCHES = 16;
export const MAX_INSERTED_NODES = 10000;
export const MAX_NESTING_DEPTH = 64;
export const ID_PATTERN_SOURCE = "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$";
const ID_PATTERN = new RegExp(ID_PATTERN_SOURCE);
export const PATCH_STATUSES = [200, 401, 409, 422, 429] as const;
export type AcceptedPatchStatus = (typeof PATCH_STATUSES)[number];
export const NAVIGATION_STATUS = 200;
export const OPERATIONS = ["children"] as const;

type TrustedPolicy = { createHTML(value: string): unknown };
const trustedTypes = (
    globalThis as typeof globalThis & {
        trustedTypes?: {
            createPolicy(
                name: string,
                rules: { createHTML(value: string): string },
            ): TrustedPolicy;
        };
    }
).trustedTypes;
// This private passthrough policy grants the framework access to the parsing
// sink. It does not sanitise or otherwise make application markup safe.
export const TRUSTED_TYPES_POLICY_NAME = "hypergraft";
const policy = trustedTypes?.createPolicy(TRUSTED_TYPES_POLICY_NAME, {
    createHTML: (value) => value,
});

export type ValidateContent = (fragment: DocumentFragment) => void;

export type PreparedBatch = {
    title?: string;
    patches: Array<{ target: HTMLElement; targetId: string; nodes: Node[] }>;
};

export type PreparedResponse =
    | { kind: "patches"; batch: PreparedBatch }
    | { kind: "navigation"; destination: string };

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

export function preflight(
    response: Response,
    text: string,
    liveDocument: Document = document,
    validateContent?: ValidateContent,
): PreparedResponse {
    if (!(PATCH_STATUSES as readonly number[]).includes(response.status))
        fail("protocol", "status");
    if (
        response.status === 429 &&
        !/^[1-9][0-9]*$/.test(response.headers.get("retry-after") ?? "")
    )
        fail("protocol", "retry-after");
    if (response.headers.get("content-type") !== MEDIA_TYPE)
        fail("protocol", "media type");
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES)
        fail("byte-limit", "size bound exceeded");
    const parser = new DOMParser();
    let parsed: Document;
    try {
        parsed = parser.parseFromString(
            (policy ? policy.createHTML(text) : text) as string,
            "text/html",
        );
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
    attributes(set, new Set(["version", "title", "navigate"]));
    if (set.getAttribute("version") !== PROTOCOL_VERSION)
        fail("protocol", "version");
    if (set.hasAttribute("navigate")) {
        if (response.status !== NAVIGATION_STATUS || set.hasAttribute("title"))
            fail("protocol", "navigation envelope");
        for (const node of set.childNodes)
            if (node.nodeType !== Node.TEXT_NODE || node.textContent?.trim())
                fail("protocol", "navigation child");
        return {
            kind: "navigation",
            destination: navigationDestination(set.getAttribute("navigate")!),
        };
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
        if (patch.getAttribute("operation") !== OPERATIONS[0])
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
        patches.push({ target, targetId: id, nodes: [...clone.childNodes] });
    }
    const survivingIds = new Set<string>();
    for (const element of liveDocument.querySelectorAll("[id]")) {
        if (
            patches.some(
                (p) => p.target.contains(element) && p.target !== element,
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
            patches,
        },
    };
}

export function apply(batch: PreparedBatch) {
    const active = document.activeElement as
        HTMLInputElement | HTMLTextAreaElement | null;
    const focusId = active?.id;
    const start = active?.selectionStart;
    const end = active?.selectionEnd;
    for (const patch of batch.patches) morphChildren(patch.target, patch.nodes);
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
