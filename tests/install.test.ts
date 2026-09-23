import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocal } from "../scripts/install";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), "olw-install-"));
  roots.push(scratch);
  const root = join(scratch, "checkout 'quoted");
  const binDir = join(scratch, "bin with spaces");
  await mkdir(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "olw-install-fixture",
      private: true,
      type: "module",
      packageManager: "pnpm@10.33.3",
      scripts: { build: "bun build.ts" },
    }),
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
  );
  await writeFile(
    join(root, "build.ts"),
    `import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await writeFile("dist/cli.js", 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));');
`,
  );
  return { scratch, root, binDir, launcher: join(binDir, "olw") };
}

test("installer builds a checkout and preserves quoted arguments and caller cwd", async () => {
  // Given a dependency-free source checkout whose paths contain shell metacharacters.
  const f = await fixture();
  // When the installer uses the actual package manager/build and the launcher is executed.
  await installLocal({ root: f.root, binDir: f.binDir });
  const child = Bun.spawn([f.launcher, "--file", "input 'quoted file.json"], {
    cwd: f.scratch,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  // Then root is explicit while user arguments and working directory remain intact.
  expect(await child.exited).toBe(0);
  expect(JSON.parse(output)).toEqual({
    args: ["--root", f.root, "--file", "input 'quoted file.json"],
    cwd: f.scratch,
  });
  expect((await stat(f.launcher)).mode & 0o111).toBe(0o111);
}, 30000);

test("reinstall keeps the owned launcher", async () => {
  // Given an existing successful installation.
  const f = await fixture();
  await installLocal({ root: f.root, binDir: f.binDir });
  const original = await readFile(f.launcher, "utf8");
  // When the same checkout is installed again.
  await installLocal({ root: f.root, binDir: f.binDir });
  // Then the launcher remains unchanged.
  expect(await readFile(f.launcher, "utf8")).toBe(original);
}, 30000);

test("build failure never replaces an existing owned launcher", async () => {
  // Given an existing successful installation.
  const f = await fixture();
  await installLocal({ root: f.root, binDir: f.binDir });
  const original = await readFile(f.launcher, "utf8");
  // When a subsequent build fails before publishing a launcher.
  await writeFile(join(f.root, "build.ts"), "process.exit(7);\n");
  // Then the error is reported and the launcher remains untouched.
  await expect(installLocal({ root: f.root, binDir: f.binDir })).rejects.toThrow(/exited 7/);
  expect(await readFile(f.launcher, "utf8")).toBe(original);
}, 30000);

test.each(["file", "symlink"] as const)(
  "installer refuses an unrelated %s before building",
  async (kind) => {
    // Given a launcher path owned by something else.
    const f = await fixture();
    await mkdir(f.binDir);
    const unrelated = join(f.scratch, "unrelated");
    await writeFile(unrelated, "keep me\n");
    if (kind === "file") await writeFile(f.launcher, "keep me\n");
    else await symlink(unrelated, f.launcher);
    // When install is requested for the occupied command name.
    // Then no build runs and neither the path nor its target is overwritten.
    await expect(installLocal({ root: f.root, binDir: f.binDir })).rejects.toThrow(
      /already exists/,
    );
    expect(await readFile(f.launcher, "utf8")).toBe("keep me\n");
    expect(await readFile(unrelated, "utf8")).toBe("keep me\n");
    expect(await Bun.file(join(f.root, "dist/cli.js")).exists()).toBe(false);
  },
);
