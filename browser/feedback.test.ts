// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import { DIAGNOSTIC_EVENT, type DiagnosticDetail } from "./diagnostics";
import { bindTransportFeedback } from "./feedback";

function markup(extra = "") {
    document.body.innerHTML = `<div data-graft-feedback hidden>
        <span data-graft-feedback-safe>Safe message</span>
        <span data-graft-feedback-uncertain hidden>Uncertain message</span>
        <button type="button" data-graft-feedback-dismiss>Dismiss</button>
        <button type="button" data-graft-feedback-reload hidden>Reload</button>
    </div>${extra}`;
    return document.querySelector<HTMLElement>("[data-graft-feedback]")!;
}

function parts() {
    return {
        root: document.querySelector<HTMLElement>("[data-graft-feedback]")!,
        safe: document.querySelector<HTMLElement>(
            "[data-graft-feedback-safe]",
        )!,
        uncertain: document.querySelector<HTMLElement>(
            "[data-graft-feedback-uncertain]",
        )!,
        dismiss: document.querySelector<HTMLButtonElement>(
            "[data-graft-feedback-dismiss]",
        )!,
        reload: document.querySelector<HTMLButtonElement>(
            "[data-graft-feedback-reload]",
        )!,
    };
}

beforeEach(() => {
    document.body.replaceChildren();
});

test("binds host slots without changing their copy or classes", () => {
    const root = markup();
    root.className = "host-alert";
    const bound = bindTransportFeedback(root);
    const elements = parts();

    bound.feedback.safeFailure();
    expect(elements.root.hidden).toBe(false);
    expect(elements.safe.hidden).toBe(false);
    expect(elements.uncertain.hidden).toBe(true);
    expect(elements.dismiss.hidden).toBe(false);
    expect(elements.reload.hidden).toBe(true);
    expect(elements.safe.textContent).toBe("Safe message");
    expect(elements.root.className).toBe("host-alert");

    bound.feedback.safeRecovery();
    expect(elements.root.hidden).toBe(true);
});

test("dismissal does not prevent a repeated safe failure", () => {
    const bound = bindTransportFeedback(markup());
    const elements = parts();

    bound.feedback.safeFailure();
    elements.dismiss.click();
    expect(elements.root.hidden).toBe(true);

    bound.feedback.safeFailure();
    expect(elements.root.hidden).toBe(false);
});

test("uncertainty takes precedence over dismissal and recovery", () => {
    const bound = bindTransportFeedback(markup());
    const elements = parts();

    bound.feedback.uncertainUnsafeOutcome();
    expect(elements.safe.hidden).toBe(true);
    expect(elements.uncertain.hidden).toBe(false);
    expect(elements.dismiss.hidden).toBe(true);
    expect(elements.reload.hidden).toBe(false);

    elements.dismiss.click();
    bound.feedback.safeRecovery();
    bound.feedback.safeFailure();
    expect(elements.root.hidden).toBe(false);
    expect(elements.uncertain.hidden).toBe(false);
});

test("the reload action reloads the current document", () => {
    const reload = vi
        .spyOn(window.location, "reload")
        .mockImplementation(() => {});
    const bound = bindTransportFeedback(markup());

    bound.feedback.uncertainUnsafeOutcome();
    parts().reload.click();

    expect(reload).toHaveBeenCalledOnce();
});

test("destroy removes button listeners and disables later presentation", () => {
    const bound = bindTransportFeedback(markup());
    const elements = parts();
    bound.feedback.safeFailure();
    bound.destroy();

    elements.dismiss.click();
    expect(elements.root.hidden).toBe(false);
    bound.feedback.safeRecovery();
    expect(elements.root.hidden).toBe(false);
});

test.each([
    ["missing", ""],
    [
        "ambiguous",
        `<div data-graft-feedback>${markupString()}</div>${markupString()}`,
    ],
    [
        "ambiguous slots",
        `<div data-graft-feedback><span data-graft-feedback-safe></span><span data-graft-feedback-safe></span><span data-graft-feedback-uncertain></span><button data-graft-feedback-dismiss></button><button data-graft-feedback-reload></button></div>`,
    ],
    [
        "non-button actions",
        `<div data-graft-feedback><span data-graft-feedback-safe></span><span data-graft-feedback-uncertain></span><span data-graft-feedback-dismiss></span><span data-graft-feedback-reload></span></div>`,
    ],
])(
    "reports %s feedback configuration and returns no-op bindings",
    (_name, html) => {
        document.body.innerHTML = html;
        const details: DiagnosticDetail[] = [];
        const listener = (event: Event) =>
            details.push((event as CustomEvent<DiagnosticDetail>).detail);
        addEventListener(DIAGNOSTIC_EVENT, listener);

        const bound = bindTransportFeedback(document);
        expect(() => {
            bound.feedback.safeFailure();
            bound.feedback.safeRecovery();
            bound.feedback.uncertainUnsafeOutcome();
            bound.destroy();
        }).not.toThrow();
        expect(details).toHaveLength(1);
        expect(details[0]).toMatchObject({ reason: "invalid-feedback" });
        expect(details[0]?.element).toBeInstanceOf(HTMLElement);
        removeEventListener(DIAGNOSTIC_EVENT, listener);
    },
);

function markupString() {
    return `<div data-graft-feedback hidden><span data-graft-feedback-safe></span><span data-graft-feedback-uncertain></span><button data-graft-feedback-dismiss></button><button data-graft-feedback-reload></button></div>`;
}
