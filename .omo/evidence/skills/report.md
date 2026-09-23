# P5 skills lane: RED/GREEN evidence

Task st_01a0c903. Worked only in `skills/**` and `.omo/evidence/skills/**`. No commits,
no package/config edits, no Herdr/model/Linear calls.

## Source

CRW pinned revision `90b1a86d894c5cac55a73a0a6b0735955acda4bb`, read from the local mirror
`/home/jun/code/linear-workflow-skills` with `git show 90b1a86d:<path>` (crw-define, crw-plan,
crw-run, crw-check SKILL.md; crw-plan/references/integrations.md;
crw-run/references/initiative-supervision.md and operations.md; plugins/crw/LICENSE).
Native OMO facts read from the installed `@code-yeongyu/senpi` dist: skill name rules
(`core/skills.js`: max 64, `^[a-z0-9-]+$`, no leading/trailing/double hyphen, description
required, max 1024), `/mcp` subcommands (`status`, `auth`, `auth-start`, `auth-complete`,
`logout`, `add`, `enable`, `disable`), and the conditional `mcp_list_resources` /
`mcp_read_resource` tools (`core/extensions/builtin/mcp/resources.js`).

## Files written

- skills/define/SKILL.md (name `oi-define`)
- skills/plan/SKILL.md (name `oi-plan`)
- skills/run/SKILL.md (name `oi-run`)
- skills/check/SKILL.md (name `oi-check`)
- skills/references/roles.md
- skills/references/linear.md
- skills/NOTICE.md (upstream MIT text and pinned revision)
- skills/skills.test.ts (frontmatter, unique names, local link resolution; no prose pinning)

## RED

Command: `bun test skills/skills.test.ts` before any skill file existed.
Result: 3 fail, exit 1. Failures were assertions (`existsSync(...)` false,
`files.length > 0` false), not import errors. Log: `red.log`.

## GREEN

Command: `bun test skills/skills.test.ts` after writing the files.
Result: 3 pass, 0 fail, 14 expect() calls, exit 0. Log: `green.log`.

Also run: `rg -n '[—–]' skills/` found no em or en dashes; `tsc --noEmit` with the repo's
strict flags on `skills/skills.test.ts` exited 0.

## Cleanup

No temporary resources were created. Nothing to close.

## Notes for the lead

- `skills/skills.test.ts` sits inside the lane's allowed paths. `bun test` discovers it, but
  `tsconfig.json` includes only `src/tests/scripts`, and `lint` covers `src tests scripts`.
  Move it to `tests/skills.test.ts` (adjusting `skillsRoot` to `../skills`) if you want it
  under typecheck and lint.
- Unresolved wording dependency: CLI command and flag names in `skills/references/roles.md`
  and the four skills (`scope import --file`, `supervisor create --initiative --scope-digest
  --designation --execute`, `parent create`, `child create`, `send --kind instruction
  --text-file`, `report --outcome --evidence --text-file`, `status`, `pause`, `resume`,
  `reconcile`, `--json`, `--fixture`, exit codes 0/2/3/4) come from
  `.omo/discovery/implementation.md` and `design.md`. P6 owns `src/cli.ts`; confirm these
  against the built CLI's `--help` and adjust the skill text if any name differs.
- Skills invoke `bun "$OMO_INITIATIVE_ROOT/dist/cli.js"`, never `bun run cli`, since role
  worktrees don't contain the control package.
- No Linear MCP tool names are asserted anywhere; the skills instruct runtime discovery via
  `/mcp` and the tool list. Live OAuth remains the user's step.
