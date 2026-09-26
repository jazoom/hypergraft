import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const repository = "jazoom/hypergraft";
const registry = "https://registry.npmjs.org";
const files = ["Cargo.toml", "Cargo.lock", "package.json"];
const usage =
    "mise run release -- patch|minor|major [--dry-run]\nmise run release -- --resume [--dry-run]";

function fail(message) {
    throw new Error(message);
}

function command(program, args = [], capture = false) {
    console.log(`> ${program} ${args.join(" ")}`);
    const result = spawnSync(program, args, {
        encoding: "utf8",
        stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
        fail(`${program} failed. Exit status: ${result.status}.`);
    return capture ? result.stdout : "";
}

function authenticatedCommand(program, args) {
    for (let attempt = 0; attempt < 2; attempt++) {
        console.log(`> ${program} ${args.join(" ")}`);
        const result = spawnSync(program, args, {
            encoding: "utf8",
            stdio: ["inherit", "pipe", "pipe"],
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.error) throw result.error;
        if (result.status === 0) return;
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
        const authenticationFailed =
            program === "npm"
                ? /\b(?:E401|ENEEDAUTH)\b/.test(output)
                : program === "gh"
                  ? /not logged into|token[^\n]*invalid|\bHTTP 401\b/i.test(
                        output,
                    )
                  : /no token found|please run `cargo login`|status(?: code)?:?\s*401\b|got 401\b|\b401 Unauthorized\b/i.test(
                        output,
                    );
        if (attempt !== 0 || !authenticationFailed)
            fail(`${program} failed. Exit status: ${result.status}.`);
        const loginArgs =
            program === "npm"
                ? ["login", "--registry", registry]
                : program === "gh"
                  ? ["auth", "login", "--hostname", "github.com"]
                  : ["login", "--registry", "crates-io"];
        if (!process.stdin.isTTY || !process.stdout.isTTY)
            fail(
                `Authentication requires an interactive terminal. Run ${program} ${loginArgs.join(" ")}.`,
            );
        console.log(`${program} requires authentication.`);
        command(program, loginArgs);
    }
}

const git = (...args) => command("git", args, true).trim();
const gh = (...args) => command("gh", [...args, "--repo", repository], true);

function ancestor(older, newer) {
    const result = spawnSync("git", [
        "merge-base",
        "--is-ancestor",
        older,
        newer,
    ]);
    if (result.status !== 0 && result.status !== 1)
        fail("Git ancestry lookup failed.");
    return result.status === 0;
}

function currentVersion() {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const cargo = readFileSync("Cargo.toml", "utf8");
    const version = cargo.match(
        /^\[package\]\nname = "hypergraft"\nversion = "([^"]+)"/m,
    )?.[1];
    if (pkg.name !== "hypergraft" || pkg.version !== version)
        fail("The Rust and npm package versions must match.");
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
        fail("The release task requires a stable major.minor.patch version.");
    return version;
}

function nextVersion(version, bump) {
    const parts = version.split(".").map(BigInt);
    const index = ["major", "minor", "patch"].indexOf(bump);
    parts[index] += 1n;
    for (let i = index + 1; i < parts.length; i++) parts[i] = 0n;
    return parts.join(".");
}

function clean() {
    if (git("status", "--porcelain")) fail("The working tree must be clean.");
}

async function confirm(version, action) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        fail("The release task requires an interactive terminal.");
    const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        const answer = await prompt.question(
            `${action}\nType ${version} to continue: `,
        );
        if (answer.trim() !== version) fail("Release cancelled.");
    } finally {
        prompt.close();
    }
}

async function published(kind, version) {
    const url =
        kind === "npm"
            ? `${registry}/hypergraft/${version}`
            : `https://crates.io/api/v1/crates/hypergraft/${version}`;
    const response = await fetch(url, {
        headers: {
            "User-Agent": `hypergraft-release (https://github.com/${repository})`,
        },
        signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    if (response.status === 404) return false;
    if (response.status === 200) return true;
    fail(`${kind} returned HTTP ${response.status}. Release stopped.`);
}

function tagCommit(tag, remote) {
    if (!remote) {
        if (!git("tag", "--list", tag)) return undefined;
        return git("rev-parse", `${tag}^{commit}`);
    }
    const lines = git(
        "ls-remote",
        "--tags",
        "origin",
        `refs/tags/${tag}`,
        `refs/tags/${tag}^{}`,
    );
    if (!lines) return undefined;
    const refs = new Map(
        lines.split("\n").map((line) => line.split(/\s+/).reverse()),
    );
    return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
}

function expectedFiles(state) {
    const patterns = [
        /^(\[package\]\nname = "hypergraft"\nversion = ")([^"]+)(")/m,
        /^(\[\[package\]\]\nname = "hypergraft"\nversion = ")([^"]+)(")/m,
        /^(\s*"version": ")([^"]+)(")/m,
    ];
    return files.map((file, index) => {
        const original = command(
            "git",
            ["show", `${state.base}:${file}`],
            true,
        );
        const match = original.match(patterns[index]);
        if (match?.[2] !== state.from)
            fail(`Unexpected version in ${file} at the release base.`);
        const updated = original.replace(
            patterns[index],
            (_match, prefix, _version, suffix) =>
                `${prefix}${state.version}${suffix}`,
        );
        return { file, original, updated };
    });
}

function prepareFiles(state) {
    const allowed = new Set(files);
    const changed = git("diff", "--name-only", "HEAD")
        .split("\n")
        .filter(Boolean);
    if (
        changed.some((file) => !allowed.has(file)) ||
        git("ls-files", "--others", "--exclude-standard")
    )
        fail("Only the release version files can differ during recovery.");
    const expected = expectedFiles(state);
    for (const { file, original, updated } of expected) {
        const actual = readFileSync(file, "utf8");
        if (actual !== original && actual !== updated)
            fail(
                `${file} contains changes outside the release version update.`,
            );
    }
    for (const { file, updated } of expected) writeFileSync(file, updated);
}

function assertReleaseCommit(state) {
    clean();
    const head = git("rev-parse", "HEAD");
    if (state.commit && head !== state.commit)
        fail("HEAD differs from the saved release commit.");
    if (
        git("show", "-s", "--format=%P", "HEAD") !== state.base ||
        git("show", "-s", "--format=%s", "HEAD") !== `Release ${state.version}`
    )
        fail("HEAD is not the expected release commit.");
    const changed = git("diff", "--name-only", state.base, "HEAD")
        .split("\n")
        .sort();
    if (JSON.stringify(changed) !== JSON.stringify([...files].sort()))
        fail("The release commit must contain only the three version files.");
    for (const { file, updated } of expectedFiles(state))
        if (readFileSync(file, "utf8") !== updated)
            fail(`Unexpected release contents in ${file}.`);
    state.commit = head;
}

async function waitForCI(commit) {
    const deadline = Date.now() + 60 * 60 * 1000;
    while (Date.now() < deadline) {
        const runs = JSON.parse(
            gh(
                "run",
                "list",
                "--workflow",
                "ci.yml",
                "--branch",
                "main",
                "--event",
                "push",
                "--commit",
                commit,
                "--limit",
                "1",
                "--json",
                "databaseId,status,conclusion",
            ),
        );
        const run = runs[0];
        if (run?.status === "completed") {
            if (run.conclusion === "success") return;
            fail(
                `CI run ${run.databaseId} ended with ${run.conclusion}. Rerun CI before release recovery.`,
            );
        }
        console.log(
            "CI has no successful result yet. The next query is in 15 seconds.",
        );
        await sleep(15_000);
    }
    fail("CI did not finish within 60 minutes. Resume after CI succeeds.");
}

async function release(state, save) {
    authenticatedCommand("gh", ["auth", "status", "--hostname", "github.com"]);
    authenticatedCommand("npm", ["whoami", "--registry", registry]);
    const origins = [
        git("remote", "get-url", "origin"),
        git("remote", "get-url", "--push", "--all", "origin"),
    ];
    const allowedOrigins = [
        `git@github.com:${repository}.git`,
        `https://github.com/${repository}.git`,
        `https://github.com/${repository}`,
    ];
    if (origins.some((origin) => !allowedOrigins.includes(origin)))
        fail(
            `origin must use one push destination at https://github.com/${repository}.`,
        );
    git("fetch", "origin", "main");
    if (
        !ancestor("origin/main", "HEAD") &&
        !(
            git("rev-parse", "HEAD") !== state.base &&
            ancestor("HEAD", "origin/main")
        )
    )
        fail("Local main diverges from origin/main or lacks remote commits.");

    const tag = `v${state.version}`;
    if (!existsSync(state.path)) {
        clean();
        if (tagCommit(tag, false) || tagCommit(tag, true))
            fail(`${tag} already exists.`);
        for (const kind of ["crate", "npm"])
            if (await published(kind, state.version))
                fail(`${kind} ${state.version} already exists.`);
        await confirm(
            state.version,
            "Prepare the release commit and push main to origin?",
        );
        save();
    }

    // A crash can occur after Git creates the commit but before the state file records it.
    if (git("rev-parse", "HEAD") !== state.base) {
        assertReleaseCommit(state);
        save();
    } else {
        if (state.commit) fail("HEAD differs from the saved release commit.");
        prepareFiles(state);
    }

    command("pnpm", ["install", "--frozen-lockfile"]);
    command("mise", ["run", "clean"]);
    command("mise", ["run", "test"]);
    command("pnpm", ["example:build"]);
    command("cargo", ["build", "--locked", "-p", "hypergraft-reference"]);
    if (!state.commit) {
        prepareFiles(state);
        git("add", "--", ...files);
        command("git", ["commit", "-m", `Release ${state.version}`]);
        assertReleaseCommit(state);
        save();
    } else assertReleaseCommit(state);

    if (state.crate === "pending")
        authenticatedCommand("cargo", [
            "publish",
            "-p",
            "hypergraft",
            "--registry",
            "crates-io",
            "--locked",
            "--dry-run",
        ]);
    if (state.npm === "pending")
        command("npm", ["publish", "--registry", registry, "--dry-run"]);
    assertReleaseCommit(state);
    git("fetch", "origin", "main");
    if (!ancestor(state.commit, "origin/main"))
        command("git", ["push", "origin", "HEAD:main"]);
    await waitForCI(state.commit);
    assertReleaseCommit(state);
    for (const remote of [false, true]) {
        const existing = tagCommit(tag, remote);
        if (existing && existing !== state.commit)
            fail(`${tag} refers to another commit.`);
    }
    await confirm(
        state.version,
        "Publish both packages, push the tag, and create the GitHub release?",
    );

    for (const kind of ["crate", "npm"]) {
        if (await published(kind, state.version)) {
            if (state[kind] === "pending")
                fail(
                    `${kind} ${state.version} exists without a recorded publication attempt.`,
                );
            console.log(
                `${kind} ${state.version} already exists. No upload is necessary.`,
            );
        } else if (state[kind] === "published") {
            fail(
                `${kind} ${state.version} is not visible yet. Resume after the registry updates.`,
            );
        } else {
            // The marker precedes the upload so recovery also covers a lost success response.
            state[kind] = "attempted";
            save();
            assertReleaseCommit(state);
            if (kind === "crate")
                authenticatedCommand("cargo", [
                    "publish",
                    "-p",
                    "hypergraft",
                    "--registry",
                    "crates-io",
                    "--locked",
                ]);
            else {
                authenticatedCommand("npm", ["whoami", "--registry", registry]);
                command("npm", ["publish", "--registry", registry]);
            }
        }
        state[kind] = "published";
        save();
    }

    assertReleaseCommit(state);
    if (!tagCommit(tag, false))
        command("git", [
            "tag",
            "-a",
            tag,
            "-m",
            `Release ${state.version}`,
            state.commit,
        ]);
    command("git", ["push", "origin", `refs/tags/${tag}`]);
    // The list call distinguishes an absent release from authentication and network errors.
    const releases = JSON.parse(
        command(
            "gh",
            ["api", "--paginate", "--slurp", `repos/${repository}/releases`],
            true,
        ),
    ).flat();
    if (!releases.some((release) => release.tag_name === tag))
        gh(
            "release",
            "create",
            tag,
            "--verify-tag",
            "--title",
            `Release ${state.version}`,
            "--generate-notes",
        );
    unlinkSync(state.path);
    console.log(
        `Released ${tag}: https://github.com/${repository}/releases/tag/${tag}`,
    );
}

async function main() {
    process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
        console.log(usage);
        return;
    }
    const dryRun = args.includes("--dry-run");
    const resume = args.includes("--resume");
    const modes = args.filter((arg) =>
        ["patch", "minor", "major"].includes(arg),
    );
    if (
        new Set(args).size !== args.length ||
        args.some(
            (arg) =>
                !["patch", "minor", "major", "--dry-run", "--resume"].includes(
                    arg,
                ),
        ) ||
        (resume ? modes.length !== 0 : modes.length !== 1)
    )
        fail(usage);
    if (git("branch", "--show-current") !== "main")
        fail("The release task requires the main branch.");
    const path = git("rev-parse", "--git-path", "hypergraft-release.json");
    let state;
    if (resume) {
        if (!existsSync(path)) fail("No saved release exists.");
        state = JSON.parse(readFileSync(path, "utf8"));
        if (state.schema !== 1)
            fail("The saved release format is not supported.");
        state.path = path;
    } else {
        if (existsSync(path))
            fail(
                "A saved release exists. Use --resume instead of another version bump.",
            );
        const from = currentVersion();
        state = {
            schema: 1,
            path,
            from,
            version: nextVersion(from, modes[0]),
            base: git("rev-parse", "HEAD"),
            commit: null,
            crate: "pending",
            npm: "pending",
        };
    }
    console.log(
        `Release ${state.from} → ${state.version}${resume ? " (resume)" : ""}`,
    );
    console.log(
        "Plan: update versions, run checks and dry runs, push main, await CI, publish, tag, and create a GitHub release.",
    );
    if (dryRun) {
        console.log(
            "Preview only. No files, Git refs, or registries changed. Remote availability and credentials remain untested.",
        );
        return;
    }
    const lock = `${path}.lock`;
    if (existsSync(lock))
        fail(`Another release or an interrupted process owns ${lock}.`);
    mkdirSync(lock);
    const save = () => {
        writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, {
            mode: 0o600,
        });
        renameSync(`${path}.tmp`, path);
    };
    try {
        await release(state, save);
    } finally {
        rmdirSync(lock);
    }
}

main().catch((error) => {
    console.error(error.message);
    console.error(
        "If a saved release exists, use mise run release -- --resume after the cause is resolved.",
    );
    process.exitCode = 1;
});
