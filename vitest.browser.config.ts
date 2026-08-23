import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const executablePath = process.env.BROWSER_EXECUTABLE_PATH;

export default defineConfig({
    test: {
        include: ["browser/**/*.browser.test.ts"],
        browser: {
            enabled: true,
            provider: playwright({
                launchOptions: executablePath ? { executablePath } : {},
            }),
            headless: true,
            instances: [{ browser: "chromium" }],
        },
    },
});
