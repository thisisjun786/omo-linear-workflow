// Executed only by isolated tests/QA. Models GitHub against a local bare repository.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkoutGit } from "../../src/repo/checkout";

const statePath = process.env["OLW_TEST_GH_STATE"];
const remote = process.env["OLW_TEST_REMOTE"];
if (!statePath || !remote) throw new Error("Isolated gh fixture configuration required");
const args = process.argv.slice(2);
await appendFile(`${statePath}.argv`, `${JSON.stringify(args)}\n`);
const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
type PR = {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  state: string;
  isCrossRepository: boolean;
};
const prs: PR[] = JSON.parse(await readFile(statePath, "utf8"));
const git = (args: string[]) => checkoutGit(remote, args);
for (const pr of prs) pr.headRefOid = await git(["rev-parse", pr.headRefName]);
if (args[1] === "list") {
  console.log(
    JSON.stringify(prs.filter((pr) => pr.state === "OPEN" && pr.headRefName === flag("--head"))),
  );
} else if (args[1] === "create") {
  const number = prs.length + 1;
  const pr = {
    number,
    url: `https://github.test/fixture/repo/pull/${number}`,
    headRefName: flag("--head"),
    baseRefName: flag("--base"),
    headRefOid: await git(["rev-parse", flag("--head")]),
    state: "OPEN",
    isCrossRepository: false,
  };
  await git(["rev-parse", pr.baseRefName]);
  prs.push(pr);
  console.log(pr.url);
} else {
  const pr = prs.find((pr) => pr.url === args[2] || String(pr.number) === args[2]);
  if (!pr) throw new Error("Unknown fixture PR");
  if (args[1] === "view") console.log(JSON.stringify(pr));
  else if (args[1] === "merge") {
    if (!args.includes("--merge") || flag("--match-head-commit") !== pr.headRefOid)
      throw new Error("Unsafe merge");
    const mergeDir = join(remote, `../merge-${pr.number}`);
    await git(["worktree", "add", "--detach", mergeDir, pr.baseRefName]);
    try {
      await checkoutGit(mergeDir, [
        "-c",
        "user.name=QA",
        "-c",
        "user.email=qa@localhost",
        "merge",
        "--no-ff",
        "-m",
        "fixture merge",
        pr.headRefOid,
      ]);
      const head = await checkoutGit(mergeDir, ["rev-parse", "HEAD"]);
      await git(["update-ref", `refs/heads/${pr.baseRefName}`, head]);
    } finally {
      await git(["worktree", "remove", mergeDir]);
    }
    pr.state = "MERGED";
  } else throw new Error("Unsupported fixture gh invocation");
}
await writeFile(statePath, JSON.stringify(prs));
