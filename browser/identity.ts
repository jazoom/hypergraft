export const RECONCILIATION = {
    attribute: "data-graft-key",
    format: 1,
    maximumBytes: 1024,
    authoredPrefix: "u:",
    generatedPrefix: "g1:",
    namespaceHexDigits: 64,
    slotMaximum: "18446744073709551615",
    semanticMaximumBytes: 1024,
    markerIdDomains: "distinct",
    scope: "siblings",
    emptyMarker: "reject",
    malformedMarker: "reject",
} as const;

function invalid(): never {
    throw new Error("invalid reconciliation metadata");
}

function validateScope(hex: string): void {
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (pair) =>
        parseInt(pair, 16),
    );
    const view = new DataView(bytes.buffer);
    const values: [number, number][] = [];
    const frame = (start: number, end: number): number => {
        if (start + 4 > end) invalid();
        const next = start + 4 + view.getUint32(start);
        if (next > end) invalid();
        values.push([start + 4, next]);
        return next;
    };
    for (let pos = 0; pos < bytes.length;) pos = frame(pos, bytes.length);
    while (values.length) {
        const [start, end] = values.pop()!;
        const tag = bytes[start];
        let pos = start + 1;
        if (tag === 98) {
            if (pos + 1 !== end || bytes[pos]! > 1) invalid();
        } else if (tag === 115 || tag === 105) {
            if (pos + 4 > end || pos + 4 + view.getUint32(pos) !== end)
                invalid();
            pos += 4;
            let text: string;
            try {
                // A BOM is payload data, not an integer prefix.
                text = new TextDecoder("utf-8", {
                    fatal: true,
                    ignoreBOM: true,
                }).decode(bytes.subarray(pos, end));
            } catch {
                invalid();
            }
            if (tag === 105) {
                if (!/^(0|-?[1-9][0-9]*)$/.test(text) || /[^0-9-]/.test(text))
                    invalid();
                const value = BigInt(text);
                if (value < -(1n << 127n) || value > (1n << 128n) - 1n)
                    invalid();
            }
        } else if (tag === 116) {
            if (pos + 4 > end) invalid();
            const count = view.getUint32(pos);
            pos += 4;
            if (count < 1 || count > 12) invalid();
            for (let i = 0; i < count; i++) pos = frame(pos, end);
            if (pos !== end) invalid();
        } else invalid();
    }
}

export function validateMarker(value: string): void {
    // Accepted metadata is ASCII, so code units equal decoded UTF-8 bytes.
    if (value.length > RECONCILIATION.maximumBytes || /[^a-z0-9:]/.test(value))
        invalid();
    if (/^u:(?:[0-9a-f]{2})+$/.test(value)) return;
    const match = /^g1:([0-9a-f]{64}):(0|[1-9][0-9]*):((?:[0-9a-f]{2})*)$/.exec(
        value,
    );
    if (!match || BigInt(match[2]!) > BigInt(RECONCILIATION.slotMaximum))
        invalid();
    validateScope(match[3]!);
}

export function effectiveKey(element: Element): string | undefined {
    const marker = element.getAttributeNS(null, RECONCILIATION.attribute);
    if (marker !== null) {
        validateMarker(marker);
        return `marker:${marker}`;
    }
    return element.id ? `id:${element.id}` : undefined;
}

export function validateSiblingKeys(roots: Iterable<Node>): void {
    const scopes = [Array.from(roots)];
    while (scopes.length) {
        const keys = new Set<string>();
        for (const node of scopes.pop()!) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const element = node as Element;
                const key = effectiveKey(element);
                if (key !== undefined) {
                    if (keys.has(key)) invalid();
                    keys.add(key);
                }
                if (element instanceof HTMLTemplateElement)
                    scopes.push(Array.from(element.content.childNodes));
            }
            if (node.childNodes.length)
                scopes.push(Array.from(node.childNodes));
        }
    }
}
