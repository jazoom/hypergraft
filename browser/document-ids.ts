import { HypergraftError } from "./diagnostics";
import { elementProperty, nodeProperty } from "./dom";
import type { PreparedPatch } from "./patches";

export const ID_PATTERN_SOURCE = "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$";
export const ID_PATTERN = new RegExp(ID_PATTERN_SOURCE);

export function addIncomingId(
    ids: Set<string>,
    id: string,
    targetId?: string,
): void {
    if (!ID_PATTERN.test(id))
        throw new HypergraftError(
            "target-content",
            "Invalid Hypergraft response: invalid ID",
            targetId,
        );
    if (ids.has(id))
        throw new HypergraftError(
            "target-content",
            "Invalid Hypergraft response: duplicate inserted ID",
            targetId,
        );
    ids.add(id);
}

export function validateDocumentIds(
    liveDocument: Document,
    patches: readonly PreparedPatch[],
    insertionIds: ReadonlySet<string>,
): void {
    const survivingIds = new Set<string>();
    for (const element of liveDocument.querySelectorAll("[id]")) {
        if (
            patches.some(
                (p) =>
                    p.operation === "children" &&
                    nodeProperty(p.target, "contains").call(
                        p.target,
                        element,
                    ) &&
                    p.target !== element,
            )
        )
            continue;
        const id = elementProperty(element, "id");
        if (
            !ID_PATTERN.test(id) ||
            survivingIds.has(id) ||
            insertionIds.has(id)
        )
            throw new HypergraftError(
                "target-content",
                "Invalid Hypergraft response: final ID collision",
            );
        survivingIds.add(id);
    }
}
