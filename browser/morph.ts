import { elementProperty, nodeProperty } from "./dom";

type PreparedMorph = {
    target: HTMLElement;
    source: Node & ParentNode;
    replace: boolean;
};
type Control =
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLOptionElement
    | HTMLSelectElement;
type ControlState = {
    node: Control;
    value?: string;
    checked?: boolean;
    indeterminate?: boolean;
    selected?: boolean;
    options?: boolean[];
    index?: number;
};
type Controls = ReturnType<typeof captureControls>;
const CONTROL_SELECTOR = "input,textarea,select,option,template";

function children(node: Node): Node & ParentNode {
    return (node instanceof HTMLTemplateElement ? node.content : node) as Node &
        ParentNode;
}

function descendants(node: Node & ParentNode): NodeListOf<Element> {
    return node instanceof HTMLFormElement
        ? Element.prototype.querySelectorAll.call(node, CONTROL_SELECTOR)
        : node.querySelectorAll(CONTROL_SELECTOR);
}

function appendNodeBatch(parent: Node, nodes: Node[]): void {
    // Valid large batches can exceed the JavaScript argument-count limit.
    const fragment = nodeProperty(
        parent,
        "ownerDocument",
    )!.createDocumentFragment();
    for (const node of nodes) fragment.appendChild(node);
    nodeProperty(parent, "appendChild").call(parent, fragment);
}

export function prepareMorph(
    target: HTMLElement,
    nodes: Node[],
    replace: boolean,
): PreparedMorph {
    const source = replace
        ? (nodeProperty(target, "cloneNode").call(target, false) as HTMLElement)
        : nodeProperty(target, "ownerDocument")!.createDocumentFragment();
    appendNodeBatch(children(source), nodes);
    // A shallow textarea clone also copies its dirty live value, not just attributes.
    if (source instanceof HTMLTextAreaElement)
        source.value = source.defaultValue;
    return { target, source, replace };
}

// Moving options out of their source select changes its selection. Inserting radios
// can change another target's state. Capture the whole batch before either happens.
export function captureControls(morphs: PreparedMorph[]) {
    const states = new Map<Element, ControlState>();
    const special = new WeakSet<Node>();
    const mark = (node: Node) => {
        for (
            let parent: Node | null = node;
            parent && !special.has(parent);
            parent = nodeProperty(parent, "parentNode")
        )
            special.add(parent);
    };
    const remember = (element: Element, options: boolean) => {
        if (element instanceof HTMLInputElement)
            states.set(element, {
                node: element,
                value: element.type === "file" ? "" : element.value,
                checked: element.checked,
                indeterminate: element.indeterminate,
            });
        else if (element instanceof HTMLTextAreaElement)
            states.set(element, { node: element, value: element.value });
        else if (element instanceof HTMLSelectElement)
            states.set(element, {
                node: element,
                options: Array.from(
                    element.options,
                    (option) => option.selected,
                ),
                index: element.selectedIndex,
            });
        else if (options && element instanceof HTMLOptionElement)
            states.set(element, { node: element, selected: element.selected });
    };
    for (const { source, target, replace } of morphs) {
        // Only children can author a target's value; its attributes remain untouched.
        if (
            replace &&
            (source instanceof HTMLSelectElement ||
                source instanceof HTMLTextAreaElement)
        ) {
            remember(source, true);
            mark(source);
            states.get(source)!.node = target as
                HTMLSelectElement | HTMLTextAreaElement;
        }
        const work = [children(source)];
        while (work.length) {
            for (const element of descendants(work.pop()!)) {
                remember(element, replace);
                mark(element);
                if (element instanceof HTMLTemplateElement)
                    work.push(element.content);
            }
        }
    }
    return {
        special(source: Element) {
            return special.has(source);
        },
        retain(node: Element, source: Element) {
            const state = states.get(source);
            if (state) state.node = node as Control;
        },
        restore() {
            const radios: ControlState[] = [];
            for (const state of states.values()) {
                const node = state.node;
                if (node instanceof HTMLInputElement) {
                    if (node.value !== state.value) node.value = state.value!;
                    if (node.indeterminate !== state.indeterminate)
                        node.indeterminate = state.indeterminate!;
                    if (node.type === "radio") radios.push(state);
                    else if (node.checked !== state.checked)
                        node.checked = state.checked!;
                } else if (node instanceof HTMLTextAreaElement) {
                    if (node.value !== state.value) node.value = state.value!;
                } else if (
                    node instanceof HTMLOptionElement &&
                    node.selected !== state.selected
                ) {
                    node.selected = state.selected!;
                }
            }
            for (const state of states.values()) {
                const node = state.node;
                if (!(node instanceof HTMLSelectElement)) continue;
                Array.from(node.options).forEach((option, index) => {
                    const selected = state.options![index] ?? false;
                    if (option.selected !== selected)
                        option.selected = selected;
                });
                if (!node.multiple && node.selectedIndex !== state.index)
                    node.selectedIndex = state.index!;
            }
            // Separate fragments may each contain a checked radio in the same final
            // group. Resolve those in final document order, not patch order.
            radios.sort((a, b) =>
                a.node.compareDocumentPosition(b.node) &
                Node.DOCUMENT_POSITION_FOLLOWING
                    ? -1
                    : 1,
            );
            for (const { node, checked } of radios)
                if (!checked && (node as HTMLInputElement).checked)
                    (node as HTMLInputElement).checked = false;
            for (const { node, checked } of radios)
                if (checked && !(node as HTMLInputElement).checked)
                    (node as HTMLInputElement).checked = true;
        },
    };
}

function identity(element: Element): string {
    if (!elementProperty(element, "attributes").length) return "";
    for (const name of ["id", "name", "href", "src"]) {
        const value = elementProperty(element, "getAttributeNS").call(
            element,
            null,
            name,
        );
        if (value) return `${name}:${value}`;
    }
    return "";
}

function matchKey(node: Node): string {
    if (!(node instanceof Element))
        return String(nodeProperty(node, "nodeType"));
    return JSON.stringify([
        elementProperty(node, "namespaceURI"),
        elementProperty(node, "localName"),
        node instanceof HTMLInputElement ? node.type : "",
        identity(node),
    ]);
}

function sameMatch(from: Node, to: Node): boolean {
    if (nodeProperty(from, "nodeType") !== nodeProperty(to, "nodeType"))
        return false;
    if (!(from instanceof Element) || !(to instanceof Element)) return true;
    return (
        elementProperty(from, "namespaceURI") ===
            elementProperty(to, "namespaceURI") &&
        elementProperty(from, "localName") ===
            elementProperty(to, "localName") &&
        (!(from instanceof HTMLInputElement) ||
            (to instanceof HTMLInputElement && from.type === to.type)) &&
        identity(from) === identity(to)
    );
}

function attributes(from: Element, source: Element): void {
    // NamedNodeMap is live: removing while iterating forwards skips attributes.
    const old = elementProperty(from, "attributes");
    for (let i = old.length - 1; i >= 0; i--) {
        const attribute = old[i]!;
        if (
            !elementProperty(source, "hasAttributeNS").call(
                source,
                attribute.namespaceURI,
                attribute.localName,
            )
        )
            elementProperty(from, "removeAttributeNS").call(
                from,
                attribute.namespaceURI,
                attribute.localName,
            );
    }
    for (const attribute of elementProperty(source, "attributes")) {
        const existing = elementProperty(from, "getAttributeNodeNS").call(
            from,
            attribute.namespaceURI,
            attribute.localName,
        );
        if (
            existing?.value === attribute.value &&
            existing.name === attribute.name
        )
            continue;
        // setAttributeNS need not change the prefix of an existing attribute.
        if (existing && existing.name !== attribute.name)
            elementProperty(from, "removeAttributeNS").call(
                from,
                attribute.namespaceURI,
                attribute.localName,
            );
        // HTML attribute names can contain colons without a namespace.
        if (attribute.namespaceURI === null)
            elementProperty(from, "setAttribute").call(
                from,
                attribute.name,
                attribute.value,
            );
        else
            elementProperty(from, "setAttributeNS").call(
                from,
                attribute.namespaceURI,
                attribute.name,
                attribute.value,
            );
    }
}

function place(parent: Node, node: Node, before: Node | null): void {
    if (
        nodeProperty(node, "parentNode") === parent &&
        nodeProperty(node, "nextSibling") === before
    )
        return;
    const move =
        parent instanceof Element
            ? elementProperty(parent, "moveBefore")
            : undefined;
    if (
        move &&
        nodeProperty(node, "parentNode") &&
        nodeProperty(node, "ownerDocument") ===
            nodeProperty(parent, "ownerDocument") &&
        nodeProperty(node, "isConnected") ===
            nodeProperty(parent, "isConnected") &&
        (node instanceof Element || node instanceof CharacterData)
    )
        move.call(parent, node, before);
    else nodeProperty(parent, "insertBefore").call(parent, node, before);
}

function stationary(sequence: number[]): Set<number> {
    const tails: number[] = [];
    const previous: number[] = [];
    for (let i = 0; i < sequence.length; i++) {
        if (sequence[i]! < 0) continue;
        let low = 0;
        let high = tails.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (sequence[tails[middle]!]! < sequence[i]!) low = middle + 1;
            else high = middle;
        }
        previous[i] = low ? tails[low - 1]! : -1;
        tails[low] = i;
    }
    const result = new Set<number>();
    for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]!) result.add(i);
    return result;
}

function equalSubtree(
    from: Element,
    source: Element,
    controls: Controls,
): boolean {
    if (
        source instanceof HTMLTemplateElement ||
        !nodeProperty(from, "isEqualNode").call(from, source)
    )
        return false;
    if (!controls.special(source)) return true;
    const incoming = descendants(source);
    // isEqualNode does not inspect a template's separate content tree.
    if (
        Array.from(incoming).some(
            (element) => element instanceof HTMLTemplateElement,
        )
    )
        return false;
    if (incoming.length) {
        const current = descendants(from);
        for (let i = 0; i < incoming.length; i++)
            controls.retain(current[i]!, incoming[i]!);
    }
    return true;
}

export function morphChildren(
    { target, source }: PreparedMorph,
    controls: Controls,
    consumeOwned?: (element: Element, source: Element) => void,
): void {
    const visit = (from: Node, to: Node) => {
        if (from instanceof Element && to instanceof Element) {
            controls.retain(from, to);
            if (!consumeOwned && equalSubtree(from, to, controls)) return;
            attributes(from, to);
            reconcile(children(from), children(to));
            consumeOwned?.(from, to);
        } else if (from.nodeValue !== to.nodeValue)
            from.nodeValue = to.nodeValue;
    };
    const reconcile = (parent: Node, incoming: Node) => {
        const old = Array.from(nodeProperty(parent, "childNodes"));
        const next = Array.from(nodeProperty(incoming, "childNodes"));
        if (
            old.length === 1 &&
            next.length === 1 &&
            sameMatch(old[0]!, next[0]!)
        ) {
            visit(old[0]!, next[0]!);
            return;
        }
        const retained = new Set<number>();
        const matches = new Array<number>(next.length).fill(-1);
        const pair = (from: number, to: number) => {
            matches[to] = from;
            retained.add(from);
        };
        const equal = (from: number, to: number) =>
            nodeProperty(old[from]!, "isEqualNode").call(old[from]!, next[to]!);
        let left = 0;
        let right = old.length - 1;
        let start = 0;
        let end = next.length - 1;
        // Equal edges cover common insertions and rotations without searching every
        // unkeyed sibling or serialising subtrees into temporary identity strings.
        while (left <= right && start <= end) {
            if (equal(left, start)) pair(left++, start++);
            else if (equal(right, end)) pair(right--, end--);
            else if (equal(left, end)) pair(left++, end--);
            else if (equal(right, start)) pair(right--, start++);
            else break;
        }
        const buckets = new Map<string, { indices: number[]; used: number }>();
        for (let i = left; i <= right; i++) {
            const key = matchKey(old[i]!);
            let bucket = buckets.get(key);
            if (!bucket) buckets.set(key, (bucket = { indices: [], used: 0 }));
            bucket.indices.push(i);
        }
        for (let i = start; i <= end; i++) {
            const bucket = buckets.get(matchKey(next[i]!));
            const index = bucket?.indices[bucket.used++] ?? -1;
            if (index >= 0) pair(index, i);
        }
        for (let i = 0; i < old.length; i++)
            if (!retained.has(i))
                nodeProperty(parent, "removeChild").call(parent, old[i]!);
        const keep = stationary(matches);
        let before: Node | null = null;
        for (let i = next.length - 1; i >= 0; i--) {
            const index = matches[i]!;
            const node = index < 0 ? next[i]! : old[index]!;
            if (index < 0 || !keep.has(i)) place(parent, node, before);
            before = node;
        }
        for (let i = 0; i < next.length; i++) {
            const index = matches[i]!;
            if (index >= 0) visit(old[index]!, next[i]!);
        }
    };
    if (
        !consumeOwned &&
        source instanceof Element &&
        equalSubtree(target, source, controls)
    )
        return;
    reconcile(children(target), children(source));
}

export function appendChildren(target: HTMLElement, nodes: Node[]): void {
    appendNodeBatch(children(target), nodes);
}
