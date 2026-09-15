import { effectiveKey } from "./identity";
import { elementProperty, nodeProperty } from "./dom";

type Control =
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLOptionElement
    | HTMLSelectElement;
type State = {
    source: Control;
    value: string;
    checked?: boolean;
    selected?: boolean;
    defaults?: string;
    selection?: boolean[];
    index?: number;
};

function children(node: Node): Node & ParentNode {
    return node instanceof HTMLTemplateElement
        ? node.content
        : (node as Node & ParentNode);
}
function key(node: Node): string | undefined {
    return node instanceof Element ? effectiveKey(node) : undefined;
}
function compatible(a: Node, b: Node): boolean {
    if (nodeProperty(a, "nodeType") !== nodeProperty(b, "nodeType"))
        return false;
    if (!(a instanceof Element) || !(b instanceof Element)) return true;
    return (
        elementProperty(a, "namespaceURI") ===
            elementProperty(b, "namespaceURI") &&
        elementProperty(a, "localName") === elementProperty(b, "localName") &&
        (!(a instanceof HTMLInputElement) ||
            (b instanceof HTMLInputElement && a.type === b.type))
    );
}

/** Source properties belong to this application only, never to a previous snapshot. */
export function captureControls(roots: Node[], retained: [Node, Node][] = []) {
    const destinations = new Map<Node, Node>(retained);
    const states: State[] = [];
    const stack = [...roots];
    while (stack.length) {
        const node = stack.pop()!;
        if (node instanceof HTMLInputElement)
            states.push({
                source: node,
                value: node.value,
                checked: node.checked,
            });
        else if (node instanceof HTMLTextAreaElement)
            states.push({
                source: node,
                value: node.value,
                defaults: node.defaultValue,
            });
        else if (node instanceof HTMLOptionElement)
            states.push({
                source: node,
                value: node.value,
                selected: node.selected,
            });
        else if (node instanceof HTMLSelectElement)
            states.push({
                source: node,
                value: node.value,
                selection: Array.from(
                    node.options,
                    (option) => option.selected,
                ),
                index: node.selectedIndex,
            });
        for (const child of nodeProperty(children(node), "childNodes"))
            stack.push(child);
    }
    states.reverse();
    const restore = () => {
        states.sort((a, b) => {
            const left = destinations.get(a.source) ?? a.source;
            const right = destinations.get(b.source) ?? b.source;
            return left.compareDocumentPosition(right) &
                Node.DOCUMENT_POSITION_FOLLOWING
                ? -1
                : 1;
        });
        const radios: { node: HTMLInputElement; checked: boolean }[] = [];
        for (const state of states) {
            const node = destinations.get(state.source) ?? state.source;
            if (node instanceof HTMLInputElement) {
                const value = node.type === "file" ? "" : state.value;
                if (node.value !== value) node.value = value;
                if (node.indeterminate) node.indeterminate = false;
                if (node.type === "radio")
                    radios.push({ node, checked: state.checked! });
                else if (node.checked !== state.checked)
                    node.checked = state.checked!;
            } else if (node instanceof HTMLTextAreaElement) {
                if (node.defaultValue !== state.defaults)
                    node.defaultValue = state.defaults!;
                if (node.value !== state.value) node.value = state.value;
            } else if (node instanceof HTMLOptionElement) {
                if (node.selected !== state.selected)
                    node.selected = state.selected!;
            }
        }
        for (const state of states) {
            const node = destinations.get(state.source) ?? state.source;
            if (node instanceof HTMLSelectElement) {
                Array.from(node.options).forEach((option, index) => {
                    const selected = state.selection![index] ?? false;
                    if (option.selected !== selected)
                        option.selected = selected;
                });
                if (!node.multiple && node.selectedIndex !== state.index)
                    node.selectedIndex = state.index!;
            }
        }
        radios.sort((a, b) =>
            a.node.compareDocumentPosition(b.node) &
            Node.DOCUMENT_POSITION_FOLLOWING
                ? -1
                : 1,
        );
        for (const { node, checked } of radios)
            if (!checked) node.checked = false;
        for (const { node, checked } of radios)
            if (checked) node.checked = true;
    };
    return {
        retain(element: Element, source: Element) {
            destinations.set(source, element);
        },
        restore,
    };
}

function place(parent: Node, node: Node, before: Node | null): void {
    if (node === before) return;
    const movable = parent as Node & {
        moveBefore?: (node: Node, before: Node | null) => void;
    };
    const moveBefore =
        parent instanceof HTMLFormElement
            ? Element.prototype.moveBefore
            : movable.moveBefore;
    if (
        typeof moveBefore === "function" &&
        nodeProperty(node, "parentNode") &&
        nodeProperty(node, "ownerDocument") ===
            nodeProperty(parent, "ownerDocument") &&
        nodeProperty(node, "isConnected") ===
            nodeProperty(parent, "isConnected") &&
        (node instanceof Element || node instanceof CharacterData)
    )
        moveBefore.call(parent, node, before);
    else nodeProperty(parent, "insertBefore").call(parent, node, before);
}

export function morphChildren(
    target: HTMLElement,
    nodes: Node[],
    consumeOwned?: (element: Element, source: Element) => void,
): void {
    const work: { parent: Node; incoming: Node[] }[] = [
        { parent: children(target), incoming: nodes },
    ];
    while (work.length) {
        const { parent, incoming } = work.pop()!;
        const old = Array.from(nodeProperty(parent, "childNodes"));
        const keyed = new Map<string, Node>();
        const unkeyed: Node[] = [];
        for (const node of old) {
            const identity = key(node);
            if (identity === undefined) unkeyed.push(node);
            else keyed.set(identity, node);
        }
        const retained = new Set<Node>();
        let ordinal = 0;
        let cursor = nodeProperty(parent, "firstChild");
        for (const source of incoming) {
            const identity = key(source);
            const candidate =
                identity === undefined
                    ? unkeyed[ordinal++]
                    : keyed.get(identity);
            const node =
                candidate && compatible(candidate, source) ? candidate : source;
            retained.add(node);
            if (node !== source) {
                if (node instanceof Element && source instanceof Element) {
                    for (const attribute of Array.from(
                        elementProperty(node, "attributes"),
                    ))
                        if (
                            !elementProperty(source, "hasAttributeNS").call(
                                source,
                                attribute.namespaceURI,
                                attribute.localName,
                            )
                        )
                            elementProperty(node, "removeAttributeNS").call(
                                node,
                                attribute.namespaceURI,
                                attribute.localName,
                            );
                    for (const attribute of elementProperty(
                        source,
                        "attributes",
                    ))
                        if (
                            elementProperty(node, "getAttributeNS").call(
                                node,
                                attribute.namespaceURI,
                                attribute.localName,
                            ) !== attribute.value
                        )
                            elementProperty(node, "setAttributeNS").call(
                                node,
                                attribute.namespaceURI,
                                attribute.name,
                                attribute.value,
                            );
                    consumeOwned?.(node, source);
                    work.push({
                        parent: children(node),
                        incoming: Array.from(
                            nodeProperty(children(source), "childNodes"),
                        ),
                    });
                } else if (node.nodeValue !== source.nodeValue)
                    node.nodeValue = source.nodeValue;
            }
            place(parent, node, cursor);
            cursor = nodeProperty(node, "nextSibling");
        }
        for (const node of old)
            if (!retained.has(node))
                nodeProperty(parent, "removeChild").call(parent, node);
    }
}

export function appendChildren(target: HTMLElement, nodes: Node[]): void {
    // A fragment avoids the JavaScript argument-count limit for large batches.
    const fragment = nodeProperty(
        target,
        "ownerDocument",
    )!.createDocumentFragment();
    for (const node of nodes) fragment.appendChild(node);
    const parent = children(target);
    nodeProperty(parent, "appendChild").call(parent, fragment);
}
