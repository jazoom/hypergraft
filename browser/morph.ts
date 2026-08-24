import { morphInner } from "morphlex";

/** Morph only preflighted nodes into a retained live target. */
export function morphChildren(target: HTMLElement, nodes: Node[]): void {
    const source = target.cloneNode(false) as HTMLElement;
    source.append(...nodes);
    morphInner(target, source, { preserveChanges: false });
}

/** Append preflighted nodes as the last children of a retained live target. */
export function appendChildren(target: HTMLElement, nodes: Node[]): void {
    target.append(...nodes);
}
