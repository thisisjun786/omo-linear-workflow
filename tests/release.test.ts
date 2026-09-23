import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function check(version: string, changelog: string, args: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "olw-release-"));
  roots.push(root);
  const manifest = join(root, "package.json");
  const notes = join(root, "CHANGELOG.md");
  await writeFile(manifest, JSON.stringify({ version }));
  await writeFile(notes, changelog);
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../scripts/release.ts"),
      "--package",
      manifest,
      "--changelog",
      notes,
      ...args,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { root, stdout, stderr, exitCode };
}

const notes = "## [Unreleased]\n\n## [0.1.0]\n### Added\n\n- Initial feature.\n";

test("CLI extracts matching release notes into a file without the heading", async () => {
  const result = await check("0.1.0", notes, [
    "--tag",
    "v0.1.0",
    "--notes-file",
    "RELEASE_NOTES.md",
  ]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ version: "0.1.0", tag: "v0.1.0", prerelease: false });
  expect(await readFile(join(result.root, "RELEASE_NOTES.md"), "utf8")).toBe(
    "### Added\n\n- Initial feature.\n",
  );
});

test("rc tag and notes are machine-readable", async () => {
  const result = await check("1.2.3-rc.2", "## [Unreleased]\n\n## [1.2.3-rc.2]\n- Candidate.\n", [
    "--tag",
    "v1.2.3-rc.2",
  ]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    version: "1.2.3-rc.2",
    tag: "v1.2.3-rc.2",
    prerelease: true,
  });
});

test.each([
  ["malformed version", "01.2.3", notes, []],
  ["zero rc", "1.2.3-rc.0", notes, []],
  ["different tag", "0.1.0", notes, ["--tag", "v0.1.1"]],
  ["tag option injection", "0.1.0", notes, ["--tag", "--notes-file"]],
  ["tag shell injection", "0.1.0", notes, ["--tag", "v0.1.0;touch /tmp/oops"]],
  ["absent section", "0.1.0", "## [Unreleased]\n- Work in progress.\n", []],
  ["mismatched section", "0.1.0", "## [0.1.1]\n- Wrong version.\n", []],
  ["empty section", "0.1.0", "## [0.1.0]\n### Added\n\n## [0.0.9]\n- Old notes.\n", []],
  ["malformed heading", "0.1.0", "## 0.1.0\n- Notes.\n", []],
  ["duplicate section", "0.1.0", "## [0.1.0]\n- One.\n## [0.1.0]\n- Two.\n", []],
  ["notes option injection", "0.1.0", notes, ["--notes-file", "--tag"]],
  ["unknown option", "0.1.0", notes, ["--unknown"]],
] as const)("rejects %s", async (_label, version, changelog, args) => {
  const result = await check(version, changelog, [...args]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.length).toBeGreaterThan(0);
  expect(result.stdout).toBe("");
});
