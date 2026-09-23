import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const paths = { package: join(root, "package.json"), changelog: join(root, "CHANGELOG.md") };
let tag: string | undefined;
let notesFile: string | undefined;
const seen = new Set<string>();

for (let i = 0; i < Bun.argv.length - 2; i += 2) {
  const flag = Bun.argv[i + 2];
  const value = Bun.argv[i + 3];
  if (!flag || !value || value.startsWith("--") || seen.has(flag)) {
    throw new Error(`Invalid release option: ${flag ?? "(missing)"}`);
  }
  seen.add(flag);
  switch (flag) {
    case "--package":
      paths.package = value;
      break;
    case "--changelog":
      paths.changelog = value;
      break;
    case "--tag":
      tag = value;
      break;
    case "--notes-file":
      notesFile = value;
      break;
    default:
      throw new Error(`Unknown release option: ${flag}`);
  }
}
if ((Bun.argv.length - 2) % 2 !== 0) throw new Error("Release options require values");

const manifest: unknown = JSON.parse(await readFile(paths.package, "utf8"));
if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
  throw new Error("Missing package version");
}
const version = manifest.version;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?$/;
if (typeof version !== "string" || !versionPattern.test(version)) {
  throw new Error(`Invalid package version: ${String(version)}`);
}
const expectedTag = `v${version}`;
if (tag !== undefined && tag !== expectedTag) throw new Error(`Tag must equal ${expectedTag}`);

const changelog = await readFile(paths.changelog, "utf8");
const headings = [...changelog.matchAll(/^##(?:[ \t]+([^\r\n]*))?\r?$/gm)];
let releaseNotes: string | undefined;
for (const [index, heading] of headings.entries()) {
  const name = heading[1];
  if (
    !name ||
    !/^\[(?:Unreleased|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?)\]$/.test(
      name,
    )
  ) {
    throw new Error(`Malformed changelog section: ${name ?? "(empty)"}`);
  }
  if (name !== `[${version}]`) continue;
  if (releaseNotes !== undefined) throw new Error(`Duplicate changelog section: ${version}`);
  const body = changelog
    .slice(heading.index + heading[0].length, headings[index + 1]?.index)
    .trim();
  if (
    !body.split("\n").some((line) => {
      const text = line.trim();
      return text.length > 0 && !/^#{1,6}\s/.test(text);
    })
  )
    throw new Error(`Empty changelog section: ${version}`);
  releaseNotes = `${body}\n`;
}
if (releaseNotes === undefined) throw new Error(`Missing changelog section: ${version}`);
if (notesFile !== undefined) await writeFile(notesFile, releaseNotes, { flag: "wx" });
process.stdout.write(
  `${JSON.stringify({ version, tag: expectedTag, prerelease: version.includes("-rc.") })}\n`,
);
