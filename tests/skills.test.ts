import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

// Mirrors the Agent Skills constraints that the installed Senpi loader enforces
// (core/skills.js: name <= 64 chars, lowercase a-z 0-9 and single hyphens,
// description required and <= 1024 chars).
const skillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

const frontmatterSchema = z.object({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(1024),
});

type Frontmatter = z.infer<typeof frontmatterSchema>;

const skillsRoot = resolve(import.meta.dir, "../skills");
const expectedSkills: ReadonlyArray<{ readonly dir: string; readonly name: string }> = [
  { dir: "define", name: "oi-define" },
  { dir: "plan", name: "oi-plan" },
  { dir: "run", name: "oi-run" },
  { dir: "check", name: "oi-check" },
];

function readFrontmatter(path: string): Frontmatter {
  const raw = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  if (match === null) {
    throw new Error(`no frontmatter block in ${path}`);
  }
  const block = match[1] ?? "";
  const fields: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return frontmatterSchema.parse(fields);
}

function localLinks(markdownPath: string): ReadonlyArray<string> {
  const raw = readFileSync(markdownPath, "utf8");
  const targets: string[] = [];
  for (const match of raw.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? "";
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) {
      continue;
    }
    targets.push(target);
  }
  return targets;
}

function markdownFiles(): ReadonlyArray<string> {
  const files = [
    ...expectedSkills.map((skill) => join(skillsRoot, skill.dir, "SKILL.md")),
    join(skillsRoot, "references", "roles.md"),
    join(skillsRoot, "references", "linear.md"),
    join(skillsRoot, "NOTICE.md"),
  ];
  return files.filter((file) => existsSync(file));
}

describe("oi skills", () => {
  test("four skills exist with unique valid frontmatter names", () => {
    const names = expectedSkills.map((skill) => {
      const path = join(skillsRoot, skill.dir, "SKILL.md");
      expect(existsSync(path)).toBe(true);
      const frontmatter = readFrontmatter(path);
      expect(frontmatter.name).toBe(skill.name);
      return frontmatter.name;
    });
    expect(new Set(names).size).toBe(expectedSkills.length);
  });

  test("shared references and MIT notice are present", () => {
    for (const file of ["references/roles.md", "references/linear.md", "NOTICE.md"]) {
      expect(existsSync(join(skillsRoot, file))).toBe(true);
    }
  });

  test("every local relative link resolves to an existing file", () => {
    const files = markdownFiles();
    expect(files.length).toBeGreaterThan(0);
    const broken: string[] = [];
    for (const file of files) {
      for (const target of localLinks(file)) {
        const [pathPart] = target.split("#");
        const resolved = resolve(dirname(file), pathPart ?? "");
        if (!existsSync(resolved)) {
          broken.push(`${file} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
