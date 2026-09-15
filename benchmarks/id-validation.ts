import { addIncomingId, validateDocumentIds } from "../browser/document-ids";
import { HypergraftError } from "../browser/diagnostics";
import { elementProperty, nodeProperty } from "../browser/dom";
import type { PreparedPatch } from "../browser/patches";

export function incomingIds(patches: readonly PreparedPatch[]): Set<string> {
    const ids = new Set<string>();
    const stack = patches.flatMap((patch) => patch.nodes);
    while (stack.length) {
        const node = stack.pop()!;
        if (nodeProperty(node, "nodeType") !== Node.ELEMENT_NODE) continue;
        const element = node as Element;
        const id = elementProperty(element, "getAttributeNS").call(
            element,
            null,
            "id",
        );
        if (id !== null) addIncomingId(ids, id);
        for (const child of nodeProperty(element, "childNodes"))
            stack.push(child);
        if (element instanceof HTMLTemplateElement)
            for (const child of element.content.childNodes) stack.push(child);
    }
    return ids;
}

export function cachedDocumentIds(document: Document) {
    let valid = false;
    let disposed = false;
    const counts = {
        fullScans: 0,
        cacheHits: 0,
        invalidations: 0,
        fallbacks: 0,
    };
    // The production document query excludes native template contents and shadow trees.
    const hasIds = (node: Node): boolean =>
        nodeProperty(node, "nodeType") === Node.ELEMENT_NODE &&
        (elementProperty(node as Element, "hasAttribute").call(node, "id") ||
            elementProperty(node as Element, "querySelector").call(
                node,
                "[id]",
            ) !== null);
    const records = (mutations: MutationRecord[]) => {
        if (
            mutations.some(
                (mutation) =>
                    mutation.type === "attributes" ||
                    [...mutation.addedNodes, ...mutation.removedNodes].some(
                        hasIds,
                    ),
            )
        ) {
            valid = false;
            counts.invalidations++;
        }
    };
    const observer = new MutationObserver(records);
    observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["id"],
    });
    return {
        counts,
        validate(
            patches: readonly PreparedPatch[],
            ids = incomingIds(patches),
        ) {
            if (disposed) throw new Error("The ID observer is disposed");
            records(observer.takeRecords());
            if (!valid) {
                counts.fullScans++;
                try {
                    // A successful hypothetical patch cannot establish current-document validity.
                    validateDocumentIds(document, [], new Set());
                    valid = true;
                } catch (error) {
                    if (!(error instanceof HypergraftError)) throw error;
                    counts.fallbacks++;
                    counts.fullScans++;
                    validateDocumentIds(document, patches, ids);
                    return;
                }
            } else counts.cacheHits++;
            for (const id of ids) {
                const existing = document.getElementById(id);
                if (
                    existing &&
                    !patches.some(
                        (patch) =>
                            patch.operation === "children" &&
                            patch.target !== existing &&
                            nodeProperty(patch.target, "contains").call(
                                patch.target,
                                existing,
                            ),
                    )
                )
                    throw new HypergraftError(
                        "target-content",
                        "final ID collision",
                    );
            }
        },
        dispose() {
            observer.disconnect();
            disposed = true;
            valid = false;
        },
    };
}
