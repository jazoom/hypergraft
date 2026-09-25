// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { emitDiagnostic } from "./diagnostics";
import {
    emitLivePatch,
    emitLiveStateChange,
    emitLocationChange,
    emitProgress,
    emitQueryPending,
    emitRequestSettled,
} from "./events";
import { bindLiveFeedback } from "./live-feedback";

let destroy: () => void;

function projection(id: string, targets = `${id}-results`): string {
    return `<form id="${id}" method="get" action="/${id}" data-graft data-graft-live></form>
        <p id="${id}-status" data-graft-live-status="${id}" data-graft-live-targets="${targets}">
            <span data-graft-live-unverified role="status">Awaiting a fresh ${id} update.</span>
            <span data-graft-live-updated hidden>Last update received <time data-graft-live-time></time>.</span>
        </p>`;
}

function form(id: string): HTMLFormElement {
    return document.getElementById(id) as HTMLFormElement;
}

function slot(id: string, name: string): HTMLElement {
    return document.querySelector<HTMLElement>(
        `#${id}-status [data-graft-live-${name}]`,
    )!;
}

function update(id: string, targetIds = [`${id}-results`]): void {
    emitLivePatch({ form: form(id), url: `http://localhost/${id}`, targetIds });
}

function disconnected(): void {
    emitLiveStateChange({
        state: "reconnecting",
        close: "retryable",
        retryDelayMs: 1000,
    });
}

function connection(): HTMLElement {
    return document.querySelector<HTMLElement>("[data-graft-live-connection]")!;
}

beforeEach(() => {
    document.documentElement.lang = "en-AU";
    document.body.innerHTML = `<p data-graft-live-announcement role="status"></p>
        <aside data-graft-live-connection hidden>
            <span data-graft-live-reconnecting>Live updates are disconnected.</span>
            <span data-graft-live-stopped hidden>Live updates stopped.</span>
        </aside>${projection("one")}${projection("two", "two-results two-summary")}`;
    destroy = bindLiveFeedback(document);
    emitLiveStateChange({ state: "connecting" });
    emitLiveStateChange({ state: "open" });
});

afterEach(() => {
    destroy();
    vi.useRealTimers();
});

test("reconnection and another projection cannot remove missing refresh evidence", () => {
    update("one");
    update("two", ["two-results", "two-summary"]);
    expect(slot("one", "unverified").hidden).toBe(true);
    expect(slot("two", "unverified").hidden).toBe(true);
    const received = slot("one", "time").textContent;
    disconnected();
    expect(connection().hidden).toBe(false);
    expect(slot("one", "unverified").hidden).toBe(false);
    expect(slot("one", "time").textContent).toBe(received);
    dispatchEvent(new Event("online"));
    emitLiveStateChange({ state: "connecting" });
    expect(connection().hidden).toBe(false);
    emitLiveStateChange({ state: "open" });
    expect(connection().hidden).toBe(true);
    expect(slot("one", "unverified").hidden).toBe(false);
    update("one");
    expect(slot("one", "unverified").hidden).toBe(true);
    update("two", ["two-results"]);
    expect(slot("two", "unverified").hidden).toBe(false);
    update("two", ["two-summary"]);
    expect(slot("two", "unverified").hidden).toBe(false);
    update("two", ["two-results", "two-summary"]);
    expect(slot("two", "unverified").hidden).toBe(true);
});

test("only a settled successful query for the exact form counts as an HTTP refresh", () => {
    const query = form("one");
    const detail = {
        requestKind: "patch" as const,
        form: query,
        url: "http://localhost/one",
        targetIds: ["one-results"],
    };
    emitRequestSettled({ ...detail, outcome: "applied-patch", status: 200 });
    expect(slot("one", "updated").hidden).toBe(true);
    emitQueryPending({ requestId: 1, form: query, pending: true });
    emitProgress({ ...detail, frame: 1 });
    expect(slot("one", "updated").hidden).toBe(true);
    emitRequestSettled({ ...detail, outcome: "applied-patch", status: 429 });
    expect(slot("one", "updated").hidden).toBe(true);
    emitRequestSettled({ ...detail, outcome: "safe-failure" });
    expect(slot("one", "updated").hidden).toBe(true);
    emitRequestSettled({
        ...detail,
        form: form("two"),
        outcome: "applied-patch",
        status: 200,
    });
    expect(slot("one", "updated").hidden).toBe(true);
    emitRequestSettled({ ...detail, outcome: "applied-patch", status: 200 });
    expect(slot("one", "updated").hidden).toBe(false);
    expect(slot("one", "unverified").hidden).toBe(true);
    emitQueryPending({ requestId: 1, form: query, pending: false });
    emitQueryPending({ requestId: 2, form: query, pending: true });
    emitQueryPending({ requestId: 2, form: query, pending: false });
    expect(slot("one", "unverified").hidden).toBe(false);
});

test("normal suspension stays quiet but requires fresh evidence after resume", () => {
    update("one");
    const received = slot("one", "time").textContent;
    emitLiveStateChange({ state: "suspended" });
    expect(connection().hidden).toBe(true);
    expect(slot("one", "unverified").hidden).toBe(true);
    expect(slot("one", "time").textContent).toBe(received);
    emitLiveStateChange({ state: "idle" });
    emitLiveStateChange({ state: "connecting" });
    emitLiveStateChange({ state: "open" });
    expect(connection().hidden).toBe(true);
    expect(slot("one", "unverified").hidden).toBe(false);
});

test("terminal loss rejects live refresh claims and uncertainty suppresses all live feedback", () => {
    update("one");
    emitLiveStateChange({ state: "stopped", close: "terminal" });
    expect(connection().hidden).toBe(false);
    expect(
        document.querySelector("[data-graft-live-announcement]")?.textContent,
    ).toBe("Live updates stopped.");
    update("one");
    expect(slot("one", "unverified").hidden).toBe(false);
    emitRequestSettled({
        requestKind: "patch",
        form: form("one"),
        url: "http://localhost/one",
        outcome: "uncertain-unsafe-result",
    });
    expect(connection().hidden).toBe(true);
    expect(
        document.querySelector("[data-graft-live-announcement]")?.textContent,
    ).toBe("");
    expect(document.getElementById("one-status")!.hidden).toBe(true);
    disconnected();
    update("two", ["two-results", "two-summary"]);
    expect(connection().hidden).toBe(true);
    expect(document.getElementById("two-status")!.hidden).toBe(true);
});

test("a successful HTTP refresh updates the timestamp after terminal socket loss", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T02:00:00Z"));
    update("one");
    emitLiveStateChange({ state: "stopped", close: "terminal" });
    vi.setSystemTime(new Date("2026-09-25T02:01:00Z"));
    const query = form("one");
    emitQueryPending({ requestId: 1, form: query, pending: true });
    emitRequestSettled({
        requestKind: "patch",
        form: query,
        url: "http://localhost/one",
        outcome: "applied-patch",
        status: 200,
        targetIds: ["one-results"],
    });
    emitQueryPending({ requestId: 1, form: query, pending: false });
    expect((slot("one", "time") as HTMLTimeElement).dateTime).toBe(
        "2026-09-25T02:01:00.000Z",
    );
    expect(slot("one", "unverified").hidden).toBe(true);
    expect(connection().hidden).toBe(false);
    expect(
        document.querySelector("[data-graft-live-announcement]")?.textContent,
    ).toBe("Live updates stopped.");
});

test("a projection error removes only that projection's evidence", () => {
    update("one");
    update("two", ["two-results", "two-summary"]);
    emitDiagnostic({
        reason: "target-content",
        requestKind: "patch",
        unsafe: false,
        url: "http://localhost/one",
        element: form("one"),
    });
    expect(slot("one", "unverified").hidden).toBe(false);
    expect(slot("two", "unverified").hidden).toBe(true);
});

test("retained markup restores observation text but changed form identity discards it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T02:00:00Z"));
    update("one");
    const received = slot("one", "time").textContent;
    document.getElementById("one-status")!.innerHTML =
        `<span data-graft-live-unverified role="status">Awaiting a fresh update.</span><span data-graft-live-updated hidden>Last update received <time data-graft-live-time></time>.</span>`;
    await Promise.resolve();
    expect(slot("one", "time").textContent).toBe(received);
    expect((slot("one", "time") as HTMLTimeElement).dateTime).toBe(
        "2026-09-25T02:00:00.000Z",
    );
    expect(slot("one", "updated").hidden).toBe(false);
    const original = form("one");
    original.replaceWith(original.cloneNode(true));
    emitLivePatch({
        form: original,
        url: "http://localhost/one",
        targetIds: ["one-results"],
    });
    expect(slot("one", "time").textContent).toBe("");
    expect(slot("one", "updated").hidden).toBe(true);
    update("one");
    expect(slot("one", "updated").hidden).toBe(false);
    form("one").remove();
    await Promise.resolve();
    expect(slot("one", "updated").hidden).toBe(true);
});

test("navigation resets retained observation times and teardown rejects late events", () => {
    update("one");
    emitLocationChange({
        cause: "history-traversal",
        url: "http://localhost/one?date=tomorrow",
    });
    expect(slot("one", "updated").hidden).toBe(true);
    expect(slot("one", "time").textContent).toBe("");
    disconnected();
    destroy();
    emitLiveStateChange({ state: "stopped" });
    update("one");
    expect(connection().hidden).toBe(true);
    expect(slot("one", "updated").hidden).toBe(true);
});
