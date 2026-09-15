import { morphInner } from "morphlex";
import { nodeProperty } from "./dom";

function appendNodeBatch(parent: HTMLElement, nodes: Node[]): void {
    // Valid large batches can exceed the JavaScript argument-count limit.
    const fragment = nodeProperty(
        parent,
        "ownerDocument",
    )!.createDocumentFragment();
    for (const node of nodes) fragment.appendChild(node);
    nodeProperty(parent, "appendChild").call(parent, fragment);
}

/** Morph only preflighted nodes into a retained live target. */
export function morphChildren(
    target: HTMLElement,
    nodes: Node[],
    consumeOwned?: (element: Element, source: Element) => void,
): void {
    const source = nodeProperty(target, "cloneNode").call(
        target,
        false,
    ) as HTMLElement;
    appendNodeBatch(source, nodes);
    morphInner(target, source, {
        preserveChanges: false,
        afterNodeVisited: consumeOwned
            ? (from, to) => {
                  if (from instanceof Element && to instanceof Element)
                      consumeOwned(from, to);
              }
            : undefined,
    });
}

/** Append preflighted nodes as the last children of a retained live target. */
export function appendChildren(target: HTMLElement, nodes: Node[]): void {
    appendNodeBatch(target, nodes);
}
