// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { MAX_RESPONSE_BYTES } from "./patches";
import { readBoundedResponse } from "./requests";

test("readBoundedResponse rejects a declared oversized response", async () => {
    const response = new Response("", {
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
    });
    await expect(readBoundedResponse(response)).rejects.toMatchObject({
        reason: "byte-limit",
    });
});

test("readBoundedResponse rejects a stream that exceeds the byte bound", async () => {
    const response = new Response("x".repeat(MAX_RESPONSE_BYTES + 1));
    await expect(readBoundedResponse(response)).rejects.toMatchObject({
        reason: "byte-limit",
    });
});

test("readBoundedResponse rejects invalid UTF-8 with a typed reason", async () => {
    const response = new Response(
        new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0xfd]),
    );
    await expect(readBoundedResponse(response)).rejects.toMatchObject({
        reason: "utf-8",
    });
});

test("readBoundedResponse decodes a valid response", async () => {
    await expect(readBoundedResponse(new Response("ready"))).resolves.toBe(
        "ready",
    );
});
