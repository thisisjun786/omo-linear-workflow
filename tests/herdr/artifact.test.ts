import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHerdr } from "../../scripts/herdr";
import { loadHerdrBuild, resolveHerdrArtifact } from "../../src/herdr/artifact";
import { ensureHerdrBuild } from "../../src/herdr/build";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const binary = '#!/bin/sh\noutput=$1\nshift\nprintf \'%s\\n\' "$HOME" "$@" > "$output"\n';
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "olw-herdr-release-"));
  roots.push(root);
  await writeFile(
    join(root, "herdr-release.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "0.9.1",
      assets: {
        [`${process.platform}-${process.arch}`]: {
          name: "herdr-linux-x86_64",
          sha256: hash(binary),
        },
      },
    }),
  );
  return { root, artifact: await loadHerdrBuild(root) };
}

test("downloads the pinned official asset and verifies it without a build receipt", async () => {
  const { root, artifact } = await fixture();
  const urls: string[] = [];
  const result = await ensureHerdrBuild(root, {
    download: async (url) => {
      urls.push(url);
      return new Response(binary);
    },
  });
  expect(urls).toEqual([
    "https://github.com/herdrdev/herdr/releases/download/v0.9.1/herdr-linux-x86_64",
  ]);
  expect(result).toEqual(artifact);
  expect(await resolveHerdrArtifact(root)).toEqual(artifact);
  expect(await Bun.file(join(artifact.artifactDir, "build.json")).exists()).toBe(false);
  const output = join(root, "argv");
  expect(await runHerdr([output, "space value", "--flag", ""], root)).toBe(0);
  expect(await Bun.file(output).text()).toBe(
    `${process.env["HOME"] ?? ""}\nspace value\n--flag\n\n`,
  );
});

test("a verified cached release needs neither network nor compilers", async () => {
  const { root, artifact } = await fixture();
  await mkdir(artifact.artifactDir, { recursive: true });
  await writeFile(artifact.binaryPath, binary, { mode: 0o700 });
  expect(
    await ensureHerdrBuild(root, {
      download: async () => {
        throw new Error("network called");
      },
    }),
  ).toEqual(artifact);
});

test("checksum mismatch fails closed before publishing any executable", async () => {
  const { root, artifact } = await fixture();
  await expect(
    ensureHerdrBuild(root, { download: async () => new Response("tampered") }),
  ).rejects.toThrow("SHA256 mismatch");
  expect(await Bun.file(artifact.binaryPath).exists()).toBe(false);
});

test("cached tampering fails closed without a replacement download", async () => {
  const { root, artifact } = await fixture();
  await mkdir(artifact.artifactDir, { recursive: true });
  await writeFile(artifact.binaryPath, "tampered", { mode: 0o700 });
  await expect(
    ensureHerdrBuild(root, {
      download: async () => {
        throw new Error("network called");
      },
    }),
  ).rejects.toThrow("SHA256 mismatch");
  await expect(resolveHerdrArtifact(root)).rejects.toThrow("SHA256 mismatch");
});

test("HTTP failure publishes no artifact", async () => {
  const { root, artifact } = await fixture();
  await expect(
    ensureHerdrBuild(root, { download: async () => new Response("unavailable", { status: 503 }) }),
  ).rejects.toThrow("503");
  expect(await Bun.file(artifact.binaryPath).exists()).toBe(false);
});

test("a missing managed release never selects a global PATH binary", async () => {
  const { root } = await fixture();
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { runHerdr } from ${JSON.stringify(join(import.meta.dir, "../../scripts/herdr.ts"))}; await runHerdr(["--version"], ${JSON.stringify(root)});`,
    ],
    {
      cwd: root,
      env: { ...process.env, PATH: bin },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).not.toBe(0);
  await expect(resolveHerdrArtifact(root)).rejects.toThrow("bun run herdr:build");
});
