// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { morphChildren } from "./morph";

function reconcile(before: string, after: string) {
    const target = document.createElement("div");
    target.innerHTML = before;
    const source = document.createElement("template");
    source.innerHTML = after;
    const old = Array.from(target.childNodes);
    const descendants = Array.from(target.querySelectorAll("*"));
    morphChildren(target, Array.from(source.content.childNodes));
    return { target, old, descendants };
}

test("keyed siblings reorder independently of unkeyed ordinals", () => {
    const { target, old } = reconcile(
        '<b id="a"></b>text<i></i><b id="b"></b>',
        '<b id="b"></b>changed<i></i><b id="a"></b>',
    );
    expect(Array.from(target.childNodes)).toEqual([
        old[3],
        old[1],
        old[2],
        old[0],
    ]);
    expect(old[1].nodeValue).toBe("changed");
});

test("incompatible candidates end descendant identity", () => {
    const { target, old } = reconcile(
        '<div id="a"><input id="child"></div>',
        '<section id="a"><input id="child"></section>',
    );
    expect(target.firstChild).not.toBe(old[0]);
    expect(target.querySelector("input")).not.toBe(
        (old[0] as Element).firstChild,
    );
    const changed = reconcile(
        '<input id="a" type="text">',
        '<input id="a" type="search">',
    );
    expect(changed.target.firstChild).not.toBe(changed.old[0]);
});

test("cross-parent keys never extract descendants", () => {
    const { target, old, descendants } = reconcile(
        '<div id="a"><b id="child"></b></div><div id="b"></div>',
        '<div id="a"></div><div id="b"><b id="child"></b></div>',
    );
    expect(target.children[0]).toBe(old[0]);
    expect(target.children[1]).toBe(old[1]);
    expect((old[0] as Element).children).toHaveLength(0);
    expect(target.querySelector("#child")).not.toBe(descendants[1]);
    expect(descendants[1].parentNode).toBeNull();
});

test("keys never cross keyed and unkeyed domains", () => {
    const { target, old } = reconcile(
        '<b></b><b id="a"></b>',
        '<b id="b"></b><b></b>',
    );
    expect(target.firstChild).not.toBe(old[0]);
    expect(target.firstChild).not.toBe(old[1]);
    expect(target.lastChild).toBe(old[0]);
    expect(old[1].parentNode).toBeNull();
});
