import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScopeSnapshot } from "../../src/core/contracts";
import { checkoutGit } from "../../src/repo/checkout";

/** Real local remote for lifecycle fixtures; new parents must be owned clones. */
export async function mappedScope(root: string, scope: ScopeSnapshot): Promise<ScopeSnapshot> {
  const seed = join(root, "fixture-source");
  await mkdir(seed, { recursive: true });
  await checkoutGit(seed, ["init", "-b", "main"]);
  await writeFile(join(seed, "README"), "fixture\n");
  await checkoutGit(seed, ["add", "README"]);
  await checkoutGit(seed, [
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@localhost",
    "commit",
    "-m",
    "fixture",
  ]);
  return {
    ...scope,
    projects: scope.projects.map((project) => ({
      ...project,
      repository: { remote: pathToFileURL(seed).href, defaultBranch: "main" },
    })),
  };
}

/** Only the parent's real clone HEAD crosses Git; other identities remain fixture-owned. */
export function fixtureTip(root: string, tip: string, cwd: string, ref: string): Promise<string> {
  return cwd.startsWith(join(root, ".omo/checkouts/")) && ref === "HEAD"
    ? checkoutGit(cwd, ["rev-parse", "HEAD"])
    : Promise.resolve(tip);
}
