import { HypergraftError } from "./diagnostics";
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
            throw new HypergraftError(
                "target-content",
                "Invalid Hypergraft response: final ID collision",
            );
        survivingIds.add(element.id);
    }
}
