import { expect, test } from "vitest";
import { observeIslands } from "./islands";
import { apply, preflightLive } from "./patches";

test("equal private keys beneath replaced ancestors end separate lifetimes", async () => {
    const host = document.createElement("div");
    host.id = "island-scopes";
    const markup =
        '<div id="parent-a"><b data-graft-key="u:61" data-island="item"></b></div><div id="parent-b"><b data-graft-key="u:61" data-island="item"></b></div>';
    host.innerHTML = markup;
    document.body.append(host);
    const roots: HTMLElement[] = [];
    const ended: { root: HTMLElement; aborted: boolean }[] = [];
    const dispose = observeIslands({
        item: (root, { signal }) => {
            roots.push(root);
            return {
                destroy() {
                    ended.push({ root, aborted: signal.aborted });
                },
            };
        },
    });
    try {
        const old = [...roots];
        const html = markup
            .replace('<div id="parent-a">', '<section id="parent-a">')
            .replace("</div>", "</section>");
        apply(
            preflightLive(
                `<graft-patch-set version="1"><graft-patch operation="children" target="island-scopes"><template>${html}</template></graft-patch></graft-patch-set>`,
            ),
        );
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(ended).toEqual([{ root: old[0], aborted: true }]);
        expect(roots).toHaveLength(3);
        expect(host.children[1].firstElementChild).toBe(old[1]);
        old[1].removeAttribute("data-island");
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(ended).toEqual(old.map((root) => ({ root, aborted: true })));
        expect(old[1].isConnected).toBe(true);
        const plain = document.createElement("i");
        host.append(plain);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        plain.setAttribute("data-island", "item");
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(roots.at(-1)).toBe(plain);
    } finally {
        dispose();
        host.remove();
    }
});

test("island lifetime follows retained roots and authored names", async () => {
    const host = document.createElement("div");
    host.id = "island-target";
    host.innerHTML =
        '<section id="root" data-island="first"><b>old</b></section>';
    document.body.append(host);
    const mounted: HTMLElement[] = [];
    const destroyed: { root: HTMLElement; aborted: boolean }[] = [];
    const initialise = (
        root: HTMLElement,
        { signal }: { signal: AbortSignal },
    ) => {
        mounted.push(root);
        return {
            destroy() {
                destroyed.push({ root, aborted: signal.aborted });
            },
        };
    };
    const dispose = observeIslands({ first: initialise, second: initialise });
    const patch = async (html: string) => {
        apply(
            preflightLive(
                `<graft-patch-set version="1"><graft-patch operation="children" target="island-target"><template>${html}</template></graft-patch></graft-patch-set>`,
            ),
        );
        await new Promise<void>((resolve) => queueMicrotask(resolve));
    };
    try {
        const root = host.firstElementChild as HTMLElement;
        await patch(
            '<section id="root" data-island="first"><b>new</b></section>',
        );
        expect(host.firstElementChild).toBe(root);
        expect(root.textContent).toBe("new");
        expect(mounted).toEqual([root]);
        await patch(
            '<section id="root" data-island="second"><b>new</b></section>',
        );
        expect(destroyed).toEqual([{ root, aborted: true }]);
        expect(mounted).toEqual([root, root]);
        await patch(
            '<article id="root" data-island="first"><b>new</b></article>',
        );
        expect(host.firstElementChild).not.toBe(root);
        expect(destroyed).toEqual([
            { root, aborted: true },
            { root, aborted: true },
        ]);
        const replacement = host.firstElementChild;
        await patch("");
        expect(destroyed).toEqual([
            { root, aborted: true },
            { root, aborted: true },
            { root: replacement, aborted: true },
        ]);
    } finally {
        dispose();
        host.remove();
    }
});
