import { expect, test, vi } from "vitest";
import { collectIslands, type IslandModule } from "./islands";

test("duplicate names fail with both sources instead of depending on discovery order", () => {
    const initialise = vi.fn();
    const first = { islands: { editor: initialise } };
    const second = { islands: () => ({ editor: initialise }) };
    for (const modules of [
        { first, second },
        { second, first },
    ]) {
        expect(() => collectIslands(modules)).toThrow(
            /editor.*first.*second|editor.*second.*first/,
        );
        expect(initialise).not.toHaveBeenCalled();
    }
});

test("each registry binds its own services without mounting during collection", () => {
    const first = vi.fn();
    const second = vi.fn();
    const modules = {
        feature: {
            islands: ({ notify }: { notify: () => void }) => ({
                editor: () => notify(),
            }),
        },
    } satisfies Record<string, IslandModule<{ notify: () => void }>>;
    const one = collectIslands(modules, { notify: first });
    const two = collectIslands(modules, { notify: second });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    const context = { signal: new AbortController().signal };
    one.editor({} as HTMLElement, context);
    one.editor({} as HTMLElement, context);
    two.editor({} as HTMLElement, context);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledOnce();
});

test("only own declarations enter an immutable registry, including prototype-like names", () => {
    const initialise = vi.fn();
    const islands = { ["__proto__"]: initialise, constructor: initialise };
    const modules = Object.create({
        inherited: { islands: { hidden: initialise } },
    });
    modules.feature = { islands };
    const registry = collectIslands(modules);
    expect(Object.getPrototypeOf(registry)).toBeNull();
    expect(registry.__proto__).toBe(initialise);
    expect(registry.constructor).toBe(initialise);
    expect(registry.toString).toBeUndefined();
    expect(registry.hidden).toBeUndefined();
    expect(Object.isFrozen(registry)).toBe(true);
    delete modules.feature;
    expect(Object.keys(registry)).toEqual(["__proto__", "constructor"]);
});

test("malformed discovered modules fail instead of silently registering nothing", () => {
    for (const module of [
        {},
        { islands: undefined },
        { islands: [] },
        { islands: () => Promise.resolve({}) },
        { islands: { editor: "not an initialiser" } },
        { islands: { "": () => {} } },
    ]) {
        expect(() =>
            collectIslands({ feature: module as unknown as IslandModule }),
        ).toThrow(/feature/);
    }
});
