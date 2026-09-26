import { afterEach, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function command(cwd: string, env: Record<string, string>, ...args: string[]) {
  const process = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  const result = await command(cwd, env, "git", ...args);
  expect(result.exitCode, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-release-publish-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  const notes = join(root, "release-notes.md");
  const ghLog = join(root, "gh.log");
  await mkdir(bin);
  await writeFile(ghLog, "");
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == api && "$2" == *actions/workflows/ci.yml/runs* ]]; then
  if [[ "\${CI_CASE:-success}" == missing ]]; then
    printf '{"workflow_runs":[]}\\n'
  else
    printf '{"workflow_runs":[{"head_sha":"%s","head_branch":"dev","event":"push","status":"completed","conclusion":"success"}]}\\n' "$RELEASE_SHA"
  fi
elif [[ "$1" == api && "$2" == *releases/tags/* ]]; then
  printf '{"status":"404"}\\n'
  exit 1
elif [[ "$1" == release && "$2" == create ]]; then
  printf '%s\\n' "$*" >> "$GH_LOG"
else
  printf 'unexpected gh call: %s\\n' "$*" >&2
  exit 90
fi
`,
  );
  await chmod(join(bin, "gh"), 0o700);
  const { PATH: inheritedPath = "" } = process.env;
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    PATH: `${bin}${delimiter}${inheritedPath}`,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Release Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Release Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GITHUB_REPOSITORY: "fixture/repository",
    RELEASE_VERSION: "1.2.3",
    RELEASE_NOTES_FILE: notes,
    GH_LOG: ghLog,
    CI_CASE: "success",
  };
  await git(root, env, "init", "--bare", "--initial-branch=main", remote);
  await git(root, env, "clone", remote, checkout);
  await mkdir(join(checkout, "scripts"));
  await cp(join(projectRoot, "scripts/release.ts"), join(checkout, "scripts/release.ts"));
  await cp(
    join(projectRoot, "scripts/release-publish.sh"),
    join(checkout, "scripts/release-publish.sh"),
  );
  await chmod(join(checkout, "scripts/release-publish.sh"), 0o755);
  await writeFile(join(checkout, "package.json"), '{"version":"1.2.3"}\n');
  await writeFile(
    join(checkout, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n## [1.2.3]\n\nReleased: 2026-09-26\n\n- Fixture release.\n",
  );
  await git(checkout, env, "add", ".");
  await git(checkout, env, "commit", "-m", "base");
  const base = await git(checkout, env, "rev-parse", "HEAD");
  await git(checkout, env, "push", "origin", "main");
  await git(checkout, env, "switch", "-c", "dev");
  await writeFile(join(checkout, "candidate"), "release\n");
  await git(checkout, env, "add", "candidate");
  await git(checkout, env, "commit", "-m", "candidate");
  const candidate = await git(checkout, env, "rev-parse", "HEAD");
  await git(checkout, env, "push", "origin", "dev");
  return {
    root,
    remote,
    checkout,
    env: { ...env, RELEASE_SHA: candidate },
    base,
    candidate,
    notes,
    ghLog,
  };
}

async function release(
  f: Fixture,
  phase: "validate" | "publish",
  overrides: Record<string, string> = {},
) {
  return command(
    f.checkout,
    { ...f.env, ...overrides },
    "bash",
    "scripts/release-publish.sh",
    phase,
  );
}

async function remoteRef(f: Fixture, ref: string) {
  return git(f.root, f.env, "--git-dir", f.remote, "rev-parse", ref);
}

test("release validation rejects a SHA outside dev", async () => {
  const f = await fixture();
  await git(f.checkout, f.env, "switch", "--detach", f.base);
  await git(f.checkout, f.env, "commit", "--allow-empty", "-m", "outside");
  const outside = await git(f.checkout, f.env, "rev-parse", "HEAD");
  const result = await release(f, "validate", { RELEASE_SHA: outside });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("not an ancestor of origin/dev");
});

test("release validation rejects a SHA without successful exact-commit CI", async () => {
  const f = await fixture();
  const result = await release(f, "validate", { CI_CASE: "missing" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("No successful CI push run");
});

test("release validation rejects a version that differs from package.json", async () => {
  const f = await fixture();
  const result = await release(f, "validate", { RELEASE_VERSION: "1.2.4" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Tag must equal v1.2.3");
});

test("release validation rejects an existing tag at another SHA", async () => {
  const f = await fixture();
  await git(f.checkout, f.env, "tag", "-a", "v1.2.3", "-m", "collision", f.base);
  await git(f.checkout, f.env, "push", "origin", "refs/tags/v1.2.3");
  const result = await release(f, "validate");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("already points to another commit");
});

test("release validation rejects a non-fast-forward main update", async () => {
  const f = await fixture();
  await git(f.checkout, f.env, "switch", "-C", "main", f.base);
  await git(f.checkout, f.env, "commit", "--allow-empty", "-m", "divergent main");
  await git(f.checkout, f.env, "push", "--force", "origin", "main");
  await git(f.checkout, f.env, "switch", "--detach", f.candidate);
  const result = await release(f, "validate");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("cannot fast-forward origin/main");
});

test("happy path creates an annotated tag, source release, and fast-forwards main", async () => {
  const f = await fixture();
  const validated = await release(f, "validate");
  expect(validated.exitCode, validated.stderr).toBe(0);
  const published = await release(f, "publish");
  expect(published.exitCode, published.stderr).toBe(0);
  expect(await remoteRef(f, "refs/tags/v1.2.3^{commit}")).toBe(f.candidate);
  expect(await remoteRef(f, "refs/heads/main")).toBe(f.candidate);
  expect(
    await git(f.root, f.env, "--git-dir", f.remote, "cat-file", "-t", "refs/tags/v1.2.3"),
  ).toBe("tag");
  expect(await readFile(f.ghLog, "utf8")).toContain(
    `release create v1.2.3 --verify-tag --target ${f.candidate}`,
  );
});
