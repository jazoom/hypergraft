import { morphInner } from "morphlex";

/** Morph only preflighted nodes into a retained live target. */
export function morphChildren(
    target: HTMLElement,
    nodes: Node[],
    consumeOwned?: (element: Element) => void,
): void {
    const source = target.cloneNode(false) as HTMLElement;
    for (const node of nodes) source.appendChild(node);
    morphInner(target, source, {
        preserveChanges: false,
        afterNodeVisited: consumeOwned
            ? (from) => {
                  if (from instanceof Element) consumeOwned(from);
              }
            : undefined,
    });
}

/** Append preflighted nodes as the last children of a retained live target. */
export function appendChildren(target: HTMLElement, nodes: Node[]): void {
    // Valid large batches can exceed the JavaScript argument-count limit.
    const fragment = target.ownerDocument.createDocumentFragment();
    for (const node of nodes) fragment.appendChild(node);
    target.appendChild(fragment);
}
