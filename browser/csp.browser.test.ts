import { afterEach, expect, test } from "vitest";
import type {
    FixtureAction,
    FixtureReady,
    FixtureResult,
} from "./fixtures/csp";

let iframe: HTMLIFrameElement | undefined;
let nextId = 1;

afterEach(() => {
    iframe?.remove();
    iframe = undefined;
});

function isReady(value: unknown): value is FixtureReady {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return record.type === "ready" && typeof record.trustedTypes === "boolean";
}

function isResult(value: unknown): value is FixtureResult {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return record.type === "result" && typeof record.id === "number";
}

function fromFixture(event: MessageEvent, frame: HTMLIFrameElement) {
    return (
        event.source === frame.contentWindow &&
        event.origin === window.location.origin
    );
}

async function openFixture(mode: "allowed" | "denied") {
    const frame = document.createElement("iframe");
    frame.title = "CSP fixture";
    const ready = new Promise<FixtureReady>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            window.removeEventListener("message", onMessage);
            reject(new Error("CSP fixture did not become ready"));
        }, 15_000);
        const onMessage = (event: MessageEvent) => {
            if (!fromFixture(event, frame) || !isReady(event.data)) return;
            window.clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            resolve(event.data);
        };
        window.addEventListener("message", onMessage);
    });
    frame.src = `/browser/fixtures/csp.html?mode=${mode}`;
    document.body.append(frame);
    iframe = frame;
    const message = await ready;
    return { frame, trustedTypes: message.trustedTypes };
}

function run(frame: HTMLIFrameElement, action: FixtureAction) {
    const id = nextId++;
    return new Promise<FixtureResult>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            window.removeEventListener("message", onMessage);
            reject(new Error(`CSP fixture action ${action} timed out`));
        }, 15_000);
        const onMessage = (event: MessageEvent) => {
            if (!fromFixture(event, frame) || !isResult(event.data)) return;
            if (event.data.id !== id) return;
            window.clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            resolve(event.data);
        };
        window.addEventListener("message", onMessage);
        frame.contentWindow?.postMessage(
            { id, action },
            window.location.origin,
        );
    });
}

test("applies a patch under the allowed Trusted Types policy", async () => {
    const { frame, trustedTypes } = await openFixture("allowed");
    const imported = await run(frame, "snapshot");
    expect(imported.ok).toBe(true);
    expect(imported.policies).toEqual([]);
    const applied = await run(frame, "apply-primary");
    expect(applied.ok).toBe(true);
    expect(applied.policies).toEqual(trustedTypes ? ["hypergraft"] : []);
    expect(applied.originalPresent).toBe(false);
    expect(applied.patchedPresent).toBe(true);
    expect(applied.violations).toEqual([]);
});

test("denies policy creation before mutation", async () => {
    const { frame, trustedTypes } = await openFixture("denied");
    const imported = await run(frame, "snapshot");
    expect(imported.ok).toBe(true);
    expect(imported.policies).toEqual([]);
    expect(imported.originalPresent).toBe(true);
    const applied = await run(frame, "apply-primary");
    if (trustedTypes) {
        expect(applied.ok).toBe(false);
        expect(applied.reason).toBe("protocol");
        expect(applied.policies).toEqual([]);
        expect(applied.originalPresent).toBe(true);
        expect(applied.patchedPresent).toBe(false);
        expect(applied.violations).toContainEqual({
            effectiveDirective: "trusted-types",
        });
        const retried = await run(frame, "apply-primary");
        expect(retried.reason).toBe("protocol");
        expect(retried.policies).toEqual([]);
        expect(retried.originalPresent).toBe(true);
        return;
    }
    expect(applied.ok).toBe(true);
    expect(applied.policies).toEqual([]);
    expect(applied.originalPresent).toBe(false);
    expect(applied.patchedPresent).toBe(true);
});

test("imports a second module copy without a second policy", async () => {
    const { frame, trustedTypes } = await openFixture("allowed");
    const imported = await run(frame, "snapshot");
    expect(imported.policies).toEqual([]);
    const started = await run(frame, "restart-runtime");
    expect(started.policies).toEqual([]);
    expect(started.violations).toEqual([]);

    const prepared = await run(frame, "preflight-primary");
    expect(prepared.ok).toBe(true);
    expect(prepared.originalPresent).toBe(true);
    if (trustedTypes) {
        expect(prepared.policies).toEqual(["hypergraft"]);
        const restarted = await run(frame, "restart-runtime");
        expect(restarted.policies).toEqual(["hypergraft"]);
        const reused = await run(frame, "preflight-primary");
        expect(reused.ok).toBe(true);
        expect(reused.policies).toEqual(["hypergraft"]);
        expect(reused.violations).toEqual([]);
        const rejected = await run(frame, "preflight-duplicate");
        expect(rejected.ok).toBe(false);
        expect(rejected.reason).toBe("protocol");
        expect(rejected.policies).toEqual(["hypergraft"]);
        expect(rejected.originalPresent).toBe(true);
        expect(rejected.patchedPresent).toBe(false);
        expect(rejected.violations).toContainEqual({
            effectiveDirective: "trusted-types",
        });
        return;
    }
    expect(prepared.policies).toEqual([]);
    const restarted = await run(frame, "restart-runtime");
    expect(restarted.policies).toEqual([]);
    const reused = await run(frame, "preflight-primary");
    expect(reused.ok).toBe(true);
    expect(reused.policies).toEqual([]);
    expect(reused.violations).toEqual([]);
    const duplicate = await run(frame, "preflight-duplicate");
    expect(duplicate.ok).toBe(true);
    expect(duplicate.policies).toEqual([]);
    expect(duplicate.originalPresent).toBe(true);
    expect(duplicate.patchedPresent).toBe(false);
});

test("policy denial leaves a command uncertain without patch mutation", async () => {
    const { frame, trustedTypes } = await openFixture("denied");
    const result = await run(frame, "submit-disabled");
    expect(result.ok).toBe(true);
    expect(result.sameButton).toBe(true);
    expect(result.pending).toBe(false);
    expect(result.policies).toEqual([]);
    if (trustedTypes) {
        expect(result.uncertain).toBe(true);
        expect(result.originalPresent).toBe(true);
        expect(result.disabled).toBe(false);
        expect(result.violations).toContainEqual({
            effectiveDirective: "trusted-types",
        });
        return;
    }
    expect(result.uncertain).toBe(false);
    expect(result.disabled).toBe(true);
});

test("an applied command keeps a server-disabled submitter disabled under CSP", async () => {
    const { frame, trustedTypes } = await openFixture("allowed");
    const result = await run(frame, "submit-disabled");
    expect(result.ok).toBe(true);
    expect(result.uncertain).toBe(false);
    expect(result.disabled).toBe(true);
    expect(result.pending).toBe(false);
    expect(result.sameButton).toBe(true);
    expect(result.policies).toEqual(trustedTypes ? ["hypergraft"] : []);
    expect(result.violations).toEqual([]);
});
