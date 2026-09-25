type NodeProperty =
    | "childNodes"
    | "nodeType"
    | "ownerDocument"
    | "isConnected"
    | "appendChild"
    | "cloneNode"
    | "contains";
type ElementProperty = "id" | "localName" | "getAttributeNS" | "outerHTML";

// Form named properties take precedence over native members, even for childNodes.
// Other elements retain their overrides and application exceptions.
export function nodeProperty<K extends NodeProperty>(
    node: Node,
    name: K,
): Node[K] {
    return node instanceof HTMLFormElement
        ? Reflect.get(Node.prototype, name, node)
        : node[name];
}

export function elementProperty<K extends ElementProperty>(
    element: Element,
    name: K,
): Element[K] {
    return element instanceof HTMLFormElement
        ? Reflect.get(Element.prototype, name, element)
        : element[name];
}
