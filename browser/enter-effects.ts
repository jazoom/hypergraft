import { emitDiagnostic, type DiagnosticDetail } from "./diagnostics";
import { elementProperty, nodeProperty } from "./dom";

export interface EnterAnimation {
    keyframes: Keyframe[] | PropertyIndexedKeyframes;
    timing: {
        duration: number;
        delay?: number;
        easing?: string;
    };
}

export interface EnterEffect extends EnterAnimation {
    reducedMotion?: EnterAnimation;
}

type CompiledEffect = {
    normal: KeyframeEffect;
    reduced?: KeyframeEffect;
};
type ActiveEffect = {
    id: string;
    animation: Animation;
    release: () => void;
};
type Issue = Extract<DiagnosticDetail, { reason: "enter-effect" }>["issue"];

export interface EnterEffects {
    capture(targets: readonly Element[]): Set<string> | undefined;
    apply(targets: readonly Element[], before?: Set<string>): void;
    destroy(): void;
}

function report(issue: Issue, element?: Element): void {
    // Optional presentation must never escape into the command failure path.
    try {
        emitDiagnostic({ reason: "enter-effect", issue, element });
    } catch {}
}

function compile(definition: EnterAnimation): KeyframeEffect {
    const { duration, delay = 0, easing = "linear" } = definition.timing;
    if (
        !Number.isFinite(duration) ||
        duration < 0 ||
        !Number.isFinite(delay) ||
        delay < 0 ||
        !Number.isFinite(duration + delay) ||
        typeof easing !== "string" ||
        Object.keys(definition.timing).some(
            (key) => !["duration", "delay", "easing"].includes(key),
        ) ||
        !definition.keyframes ||
        typeof definition.keyframes !== "object"
    )
        throw new TypeError("Invalid entry effect");
    // One iteration and no fill keep the server-authored resting state authoritative.
    return new KeyframeEffect(null, definition.keyframes, {
        duration,
        delay,
        easing,
        iterations: 1,
        fill: "none",
    });
}

function descendants(root: Element, selector: string): NodeListOf<Element> {
    return Element.prototype.querySelectorAll.call(root, selector);
}

export function createEnterEffects(
    definitions: Record<string, EnterEffect>,
): EnterEffects {
    const effects = new Map<string, CompiledEffect | undefined>();
    const active = new Map<Element, ActiveEffect>();
    let disposed = false;
    let motion: MediaQueryList | undefined;
    let observer: MutationObserver | undefined;

    const cancel = (entry: ActiveEffect) => {
        entry.release();
        try {
            entry.animation.cancel();
        } catch {
            report("animation-failure");
        }
    };
    const cancelAll = () => {
        for (const entry of active.values()) cancel(entry);
    };
    const prune = () => {
        for (const [element, entry] of active) {
            if (
                !nodeProperty(element, "isConnected") ||
                elementProperty(element, "id") !== entry.id
            )
                cancel(entry);
        }
    };
    const onMotionChange = () => cancelAll();

    try {
        if (
            typeof KeyframeEffect !== "function" ||
            typeof Animation !== "function" ||
            typeof matchMedia !== "function"
        ) {
            report("unavailable");
        } else {
            motion = matchMedia("(prefers-reduced-motion: reduce)");
            motion.addEventListener("change", onMotionChange);
            observer = new MutationObserver(() => {
                try {
                    prune();
                } catch {
                    report("animation-failure");
                }
            });
            for (const [name, definition] of Object.entries(definitions)) {
                effects.set(name, undefined);
                try {
                    effects.set(name, {
                        normal: compile(definition),
                        reduced:
                            definition.reducedMotion === undefined
                                ? undefined
                                : compile(definition.reducedMotion),
                    });
                } catch {
                    report("invalid-definition");
                }
            }
        }
    } catch {
        report("unavailable");
    }

    const enter = (element: Element, before: Set<string>) => {
        const name = elementProperty(element, "getAttributeNS").call(
            element,
            null,
            "data-graft-enter",
        );
        if (name === null) return;
        const id = elementProperty(element, "id");
        if (!id) {
            report("missing-id", element);
            return;
        }
        if (before.has(id) || !nodeProperty(element, "isConnected")) return;
        if (!effects.has(name)) {
            report("unknown-effect", element);
            return;
        }
        const effect = effects.get(name);
        if (!effect) return;
        const source = motion?.matches ? effect.reduced : effect.normal;
        if (!source) return;
        const keyframes = new KeyframeEffect(source);
        keyframes.target = element;
        const animation = new Animation(keyframes, document.timeline);
        const release = () => {
            animation.removeEventListener("finish", release);
            animation.removeEventListener("cancel", release);
            active.delete(element);
            if (active.size === 0) observer?.disconnect();
        };
        const entry = { id, animation, release };
        try {
            active.set(element, entry);
            animation.addEventListener("finish", release);
            animation.addEventListener("cancel", release);
            observer?.observe(document, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["id"],
            });
            animation.play();
        } catch {
            cancel(entry);
            report("animation-failure", element);
        }
    };

    return {
        capture(targets) {
            if (disposed || effects.size === 0) return;
            try {
                const before = new Set<string>();
                for (const target of targets) {
                    before.add(elementProperty(target, "id"));
                    for (const element of descendants(target, "[id]"))
                        before.add(elementProperty(element, "id"));
                }
                return before;
            } catch {
                report("animation-failure");
            }
        },
        apply(targets, before) {
            if (disposed) return;
            try {
                if (!before) {
                    cancelAll();
                    return;
                }
                prune();
                for (const target of targets) {
                    for (const element of [
                        target,
                        ...descendants(target, "[data-graft-enter]"),
                    ]) {
                        try {
                            enter(element, before);
                        } catch {
                            report("animation-failure", element);
                        }
                    }
                }
            } catch {
                report("animation-failure");
            }
        },
        destroy() {
            disposed = true;
            cancelAll();
            observer?.disconnect();
            motion?.removeEventListener("change", onMotionChange);
            effects.clear();
        },
    };
}
