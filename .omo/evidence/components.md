# Bounded verification report — implementation phase (V)

Scope: read-only verification of `/home/jun/code/omo-initiative`. No production files were modified. No live Linear or Herdr sessions were launched.

## 1. Reconstructed producer scopes (from `.omo/discovery/implementation.md`)

| Phase | Owner | Contracted paths |
|-------|-------|------------------|
| P1 core | core producer | `src/core/**`, `tests/store.test.ts`, `tests/core/**`, `.omo/evidence/core/**` |
| P2 Herdr | Herdr producer | `src/herdr/**`, `tests/herdr.test.ts`, `tests/herdr/**`, `.omo/evidence/herdr/**` |
| P3 native transport | transport producer | `src/transport/**`, `src/extension/**`, `tests/events.test.ts`, `tests/transport/**`, `.omo/evidence/transport/**` |
| P4 Linear adapter | Linear producer | `src/linear/**`, `tests/linear.test.ts`, `tests/linear/**`, `tests/fixtures/scope.json`, `.omo/evidence/linear/**` |
| P5 skills | skills producer | `skills/**`, `.omo/evidence/skills/**` |
| P6 CLI integration | CLI producer | `src/cli.ts`, `src/orchestrator.ts`, `src/host-profile.ts`, `tests/integration/**`, `scripts/build.ts`, `README.md`, `.omo/evidence/cli/**` |
| V mechanical verification | verifier | `.omo/evidence/components.md` (this file) |
| Lead / shared | lead | live Herdr/OMO/MCP QA, `qa-*` scripts/resources, package/config/lockfiles, commits, post-lane integration fixes |

## 2. Command results

All commands were run exactly once from `/home/jun/code/omo-initiative`.

### 2.1 `bun test`

```bash
cd /home/jun/code/omo-initiative && bun test
```

**Exit code: 0**

Result: 41 pass, 0 fail, 154 expect() calls across 8 files. No failing assertions.

### 2.2 `bun run typecheck`

```bash
cd /home/jun/code/omo-initiative && bun run typecheck
```

**Exit code: 0**

Output:
```
$ tsc --noEmit
```

### 2.3 `bun run lint`

```bash
cd /home/jun/code/omo-initiative && bun run lint
```

**Exit code: 1**

Lint failed. Full captured output (Biome suppressed 6 additional diagnostics after its limit):

```
$ biome check src tests scripts
scripts/qa-linear.ts:61:45 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    59 │       case "initialize":
    60 │         result = {
  > 61 │           protocolVersion: message.params?.["protocolVersion"],
       │                                             ^^^^^^^^^^^^^^^^^
    62 │           capabilities: { tools: {} },
    63 │           serverInfo: { name: "linear-qa-fixture", version: "1.0.0" },
  
  i Unsafe fix: Use a literal key instead.
  
    61 │ ··········protocolVersion:·message.params?.protocolVersion,
       │                                            ──               ── 

scripts/qa-rpc.ts:86:76 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    84 │       const timer = setTimeout(() => {
    85 │         pending.delete(id);
  > 86 │         result.reject(new QaError(`RPC request timed out: ${String(command["type"])}`));
       │                                                                            ^^^^^^
    87 │       }, timeoutMs);
       │       pending.set(id, { resolve: result.resolve, reject: result.reject, timer });
  
  i Unsafe fix: Use a literal key instead.
  
     84  84 │         const timer = setTimeout(() => {
     85  85 │           pending.delete(id);
     86     │ - ········result.reject(new·QaError(`RPC·request·timed·out:·${String(command["type"])}`));
         86 │ + ········result.reject(new·QaError(`RPC·request·timed·out:·${String(command.type)}`));
     87  87 │         }, timeoutMs);
     88  88 │         pending.set(id, { resolve: result.resolve, reject: result.reject, timer });
  

scripts/qa-world.ts:36:19 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    35 │ export async function prepareQaWorld() {
  > 36 │   if (process.env["HERDR_ENV"] !== "1") throw new QaError("Herdr QA requires HERDR_ENV=1");
       │                   ^^^^^^^^^^^
    37 │   const installRoot = resolve(import.meta.dir, "..");
    38 │   const scratch = await mkdtemp(join(installRoot, ".omo/evidence/qa-world-"));
  
  i Unsafe fix: Use a literal key instead.
  
     34  34 │   
     35  35 │   export async function prepareQaWorld() {
     36     │ - ··if·(process.env["HERDR_ENV"]·!==·"1")·throw·new·QaError("Herdr·QA·requires·HERDR_ENV=1");
         36 │ + ··if·(process.env.HERDR_ENV·!==·"1")·throw·new·QaError("Herdr·QA·requires·HERDR_ENV=1");
     37  37 │     const installRoot = resolve(import.meta.dir, "..");
     38  38 │     const scratch = await mkdtemp(join(installRoot, ".omo/evidence/qa-world-"));
  

src/cli.ts:78:25 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    76 │ }
    77 │ function evidence(options: Options): readonly string[] {
  > 78 │   const value = options["evidence"];
       │                         ^^^^^^^^^^
    79 │   return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  
  i Unsafe fix: Use a literal key instead.
  
    76  76 │   }
    77  77 │   function evidence(options: Options): readonly string[] {
    78     │ - ··const·value·=·options["evidence"];
         78 │ + ··const·value·=·options.evidence;
    79  79 │     return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    80  80 │   }
  

src/cli.ts:169:55 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    167 │       const values = requireOptions(options, ["file"]);
    168 │       result = values.ok
  > 169 │         ? await orchestrator.importScope(values.value["file"] ?? "", has(options, "fixture"))
        │                                                       ^^^^^^
    170 │         : values;
  
  i Unsafe fix: Use a literal key instead.
  
    167 167 │         const values = requireOptions(options, ["file"]);
    168 168 │         result = values.ok
    169     │ - ········?·await·orchestrator.importScope(values.value["file"]·??·"",·has(options,·"fixture"))
        169 │ + ········?·await·orchestrator.importScope(values.value.file·??·"",·has(options,·"fixture"))
    170 170 │           : values;
    171 171 │       } else if (command === "supervisor create") {
  

src/cli.ts:175:40 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    173 │       result = values.ok
    174 │         ? await orchestrator.createSupervisor({
  > 175 │             initiativeId: values.value["initiative"] ?? "",
        │                                        ^^^^^^^^^^^^
    176 │             scopeDigest: values.value["scope-digest"] ?? "",
    177 │             designationId: values.value["designation"] ?? "",
  
  i Unsafe fix: Use a literal key instead.
  
    173 173 │         result = values.ok
    174 174 │           ? await orchestrator.createSupervisor({
    175     │ - ············initiativeId:·values.value["initiative"]·??·"",
        175 │ + ············initiativeId:·values.value.initiative·??·"",
    176 176 │               scopeDigest: values.value["scope-digest"] ?? "",
    177 177 │               designationId: values.value["designation"] ?? "",
  

src/cli.ts:177:41 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    175 │             initiativeId: values.value["initiative"] ?? "",
    176 │             scopeDigest: values.value["scope-digest"] ?? "",
  > 177 │             designationId: values.value["designation"] ?? "",
        │                                         ^^^^^^^^^^^^^
    178 │             execute: has(options, "execute"),
    179 │             fixture: has(options, "fixture"),
  
  i Unsafe fix: Use a literal key instead.
  
    175 175 │               initiativeId: values.value["initiative"] ?? "",
    176 176 │               scopeDigest: values.value["scope-digest"] ?? "",
    177     │ - ············designationId:·values.value["designation"]·??·"",
        177 │ + ············designationId:·values.value.designation·??·"",
    178 178 │               execute: has(options, "execute"),
    179 179 │               fixture: has(options, "fixture"),
  

src/cli.ts:186:40 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    184 │       result = values.ok
    185 │         ? await orchestrator.createParent({
  > 186 │             supervisorId: values.value["supervisor"] ?? "",
        │                                        ^^^^^^^^^^^^
    187 │             projectId: values.value["project"] ?? "",
    188 │             repo: values.value["repo"] ?? "",
  
  i Unsafe fix: Use a literal key instead.
  
    184 184 │         result = values.ok
    185 185 │           ? await orchestrator.createParent({
    186     │ - ············supervisorId:·values.value["supervisor"]·??·"",
        186 │ + ············supervisorId:·values.value.supervisor·??·"",
    187 187 │               projectId: values.value["project"] ?? "",
    188 188 │               repo: values.value["repo"] ?? "",
  

src/cli.ts:187:37 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    185 │         ? await orchestrator.createParent({
    186 │             supervisorId: values.value["supervisor"] ?? "",
  > 187 │             projectId: values.value["project"] ?? "",
        │                                     ^^^^^^^^^
    188 │             repo: values.value["repo"] ?? "",
    189 │             base: values.value["base"] ?? "",
  
  i Unsafe fix: Use a literal key instead.
  
    185 185 │           ? await orchestrator.createParent({
    186 186 │               supervisorId: values.value["supervisor"] ?? "",
    187     │ - ············projectId:·values.value["project"]·??·"",
        187 │ + ············projectId:·values.value.project·??·"",
    188 188 │               repo: values.value["repo"] ?? "",
    189 189 │               base: values.value["base"] ?? "",
  

src/cli.ts:188:32 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    186 │             supervisorId: values.value["supervisor"] ?? "",
    187 │             projectId: values.value["project"] ?? "",
  > 188 │             repo: values.value["repo"] ?? "",
        │                                ^^^^^^
    189 │             base: values.value["base"] ?? "",
    190 │           })
  
  i Unsafe fix: Use a literal key instead.
  
    186 186 │               supervisorId: values.value["supervisor"] ?? "",
    187 187 │               projectId: values.value["project"] ?? "",
    188     │ - ············repo:·values.value["repo"]·??·"",
        188 │ + ············repo:·values.value.repo·??·"",
    189 189 │               base: values.value["base"] ?? "",
    190 190 │             })
  

src/cli.ts:189:32 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    187 │             projectId: values.value["project"] ?? "",
    188 │             repo: values.value["repo"] ?? "",
  > 189 │             base: values.value["base"] ?? "",
        │                                ^^^^^^
    190 │           })
    191 │         : values;
  
  i Unsafe fix: Use a literal key instead.
  
    187 187 │               projectId: values.value["project"] ?? "",
    188 188 │               repo: values.value["repo"] ?? "",
    189     │ - ············base:·values.value["base"]·??·"",
        189 │ + ············base:·values.value.base·??·"",
    190 190 │             })
    191 191 │           : values;
  

src/cli.ts:196:36 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    194 │       result = values.ok
    195 │         ? await orchestrator.createChild({
  > 196 │             parentId: values.value["parent"] ?? "",
        │                                    ^^^^^^^^
    197 │             issueId: values.value["issue"] ?? "",
  
  i Unsafe fix: Use a literal key instead.
  
    194 194 │         result = values.ok
    195 195 │           ? await orchestrator.createChild({
    196     │ - ············parentId:·values.value["parent"]·??·"",
        196 │ + ············parentId:·values.value.parent·??·"",
    197 197 │               issueId: values.value["issue"] ?? "",
    198 198 │             })
  

src/cli.ts:197:35 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    195 │         ? await orchestrator.createChild({
    196 │             parentId: values.value["parent"] ?? "",
  > 197 │             issueId: values.value["issue"] ?? "",
        │                                   ^^^^^^^
    198 │           })
    199 │         : values;
  
  i Unsafe fix: Use a literal key instead.
  
    195 195 │           ? await orchestrator.createChild({
    196 196 │               parentId: values.value["parent"] ?? "",
    197     │ - ············issueId:·values.value["issue"]·??·"",
        197 │ + ············issueId:·values.value.issue·??·"",
    198 198 │             })
    199 199 │           : values;
  

src/cli.ts:203:74 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    201 │       const values = requireOptions(options, ["from", "to", "id", "kind", "text-file"]);
    202 │       const kind = values.ok
  > 203 │         ? z.enum(["instruction", "coordination"]).safeParse(values.value["kind"])
        │                                                                          ^^^^^^
    204 │         : undefined;
  
  i Unsafe fix: Use a literal key instead.
  
    201 201 │         const values = requireOptions(options, ["from", "to", "id", "kind", "text-file"]);
    202 202 │         const kind = values.ok
    203     │ - ········?·z.enum(["instruction",·"coordination"]).safeParse(values.value["kind"])
        203 │ + ········?·z.enum(["instruction",·"coordination"]).safeParse(values.value.kind)
    204 204 │           : undefined;
    205 205 │         const body = values.ok
  

src/cli.ts:211:36 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    209 │         values.ok && kind?.success && body.ok
    210 │           ? await orchestrator.send({
  > 211 │               fromId: values.value["from"] ?? "",
        │                                    ^^^^^^
    212 │               toId: values.value["to"] ?? "",
    213 │               messageId: values.value["id"] ?? "",
  
  i Unsafe fix: Use a literal key instead.
  
    209 209 │           values.ok && kind?.success && body.ok
    210 210 │             ? await orchestrator.send({
    211     │ - ··············fromId:·values.value["from"]·??·"",
        211 │ + ··············fromId:·values.value.from·??·"",
    212 212 │                 toId: values.value["to"] ?? "",
    213 213 │                 messageId: values.value["id"] ?? "",
  

src/cli.ts:212:34 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    210 │           ? await orchestrator.send({
    211 │               fromId: values.value["from"] ?? "",
  > 212 │               toId: values.value["to"] ?? "",
        │                                  ^^^^
    213 │               messageId: values.value["id"] ?? "",
    214 │               kind: kind.data,
  
  i Unsafe fix: Use a literal key instead.
  
    210 210 │             ? await orchestrator.send({
    211 211 │                 fromId: values.value["from"] ?? "",
    212     │ - ··············toId:·values.value["to"]·??·"",
        212 │ + ··············toId:·values.value.to·??·"",
    213 213 │                 messageId: values.value["id"] ?? "",
    214 214 │                 kind: kind.data,
  

src/cli.ts:213:39 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    211 │               fromId: values.value["from"] ?? "",
    212 │               toId: values.value["to"] ?? "",
  > 213 │               messageId: values.value["id"] ?? "",
        │                                       ^^^^
    214 │               kind: kind.data,
    215 │               text: body.value,
  
  i Unsafe fix: Use a literal key instead.
  
    211 211 │                 fromId: values.value["from"] ?? "",
    212 212 │                 toId: values.value["to"] ?? "",
    213     │ - ··············messageId:·values.value["id"]·??·"",
        213 │ + ··············messageId:·values.value.id·??·"",
    214 214 │                 kind: kind.data,
    215 215 │                 text: body.value,
  

src/cli.ts:225:77 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    223 │       const values = requireOptions(options, ["from", "id", "outcome", "text-file"]);
    224 │       const outcome = values.ok
  > 225 │         ? z.enum(["completed", "blocked", "failed"]).safeParse(values.value["outcome"])
        │                                                                             ^^^^^^^^^
    226 │         : undefined;
  
  i Unsafe fix: Use a literal key instead.
  
    223 223 │         const values = requireOptions(options, ["from", "id", "outcome", "text-file"]);
    224 224 │         const outcome = values.ok
    225     │ - ········?·z.enum(["completed",·"blocked",·"failed"]).safeParse(values.value["outcome"])
        225 │ + ········?·z.enum(["completed",·"blocked",·"failed"]).safeParse(values.value.outcome)
    226 226 │           : undefined;
    227 227 │         const body = values.ok
  

src/cli.ts:233:36 lint/complexity/useLiteralKeys  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  i The computed expression can be simplified without the use of a string literal.
  
    231 │         values.ok && outcome?.success && body.ok
    232 │           ? await orchestrator.report({
  > 233 │               fromId: values.value["from"] ?? "",
        │                                    ^^^^^^
    234 │               messageId: values.value["id"] ?? "",
    235 │               outcome: outcome.data,
  
  i Unsafe fix: Use a literal key instead.
  
    231 231 │           values.ok && outcome?.success && body.ok
    232 232 │             ? await orchestrator.report({
    233     │ - ··············fromId:·values.value["from"]·??·"",
        233 │ + ··············fromId:·values.value.from·??·"",
    234 234 │                 messageId: values.value["id"] ?? "",
    235 235 │                 outcome: outcome.data,
  

scripts/qa-world.ts:1:1 assist/source/organizeImports  FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  × Sort these imports.
  
  > 1 │ import { RpcClient } from "@code-yeongyu/senpi";
      │ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  > 2 │ import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
  > 3 │ import { join, resolve } from "node:path";
      │ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    4 │ import { openRegistry } from "../src/core/store";
    5 │ import { QaError } from "./qa-rpc";
  
  i Safe fix: Organize imports and exports (Biome)
  
      1     │ - import·{·RpcClient·}·from·"@code-yeongyu/senpi";
      2     │ - import·{·cp,·lstat,·mkdir,·mkdtemp,·rm,·writeFile·}·from·"node:fs/promises";
      3     │ - import·{·join,·resolve·}·from·"node:path";
          1 │ + import·{·cp,·lstat,·mkdir,·mkdtemp,·rm,·writeFile·}·from·"node:fs/promises";
          2 │ + import·{·join,·resolve·}·from·"node:path";
          3 │ + import·{·RpcClient·}·from "@code-yeongyu/senpi";
      4   4 │   import { openRegistry } from "../src/core/store";
      5   5 │ import { QaError } from "./qa-rpc";
  

The number of diagnostics exceeds the limit allowed. Use --max-diagnostics to increase it.
Diagnostics not shown: 6.
Checked 36 files in 12ms. No fixes applied.
Found 1 error.
Found 25 infos.
check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  × Some errors were emitted while running checks.
  

error: script "lint" exited with code 1
```

Note: the 1 emitted error is the `organizeImports` diagnostic in `scripts/qa-world.ts`. The remaining 25 entries are `useLiteralKeys` infos (FIXABLE). Biome reported "Found 1 error. Found 25 infos." and suppressed 6 additional diagnostics.

### 2.4 `bun run build`

```bash
cd /home/jun/code/omo-initiative && bun run build
```

**Exit code: 0**

Output:
```
$ bun scripts/build.ts
Built dist/cli.js, dist/core/worker.js, dist/extension/index.js
```

### 2.5 `bun dist/cli.js --root /home/jun/code/omo-initiative status --json`

```bash
cd /home/jun/code/omo-initiative && bun dist/cli.js --root /home/jun/code/omo-initiative status --json
```

**Exit code: 0**

Output:
```json
{"ok":true,"value":[]}
```

## 3. Unexpected files

Files present in the tree that are not clearly assigned to any producer scope in `.omo/discovery/implementation.md`:

- `scripts/probe-models.ts` — not a `qa-*` script (lead-owned QA scripts are `qa-*`) and not listed in any producer phase.
- `tests/skills.test.ts` — tests skills behavior but `tests/skills/**` is not listed in P5; only `skills/**` and `.omo/evidence/skills/**` are contracted. This is scope-adjacent but unassigned.
- `.omo/evidence/.gitkeep` — harmless directory placeholder; noted for completeness.
- Top-level evidence files outside producer evidence directories:
  - `.omo/evidence/linear-runtime.md`
  - `.omo/evidence/models.md`
  - `.omo/evidence/native-probe.mjs`
  - `.omo/evidence/native-thread.md`
  - `.omo/evidence/probe-native-client.mjs`
  These may be lead QA resources, but they are not listed in any producer scope.

No verification command created new unexpected files; `dist/` was rebuilt in place as expected by `bun run build`.

## 4. Overall assessment

| Check | Exit code | Status |
|-------|-----------|--------|
| `bun test` | 0 | PASS |
| `bun run typecheck` | 0 | PASS |
| `bun run lint` | 1 | **FAIL** |
| `bun run build` | 0 | PASS |
| `bun dist/cli.js ... status --json` | 0 | PASS |

**Overall: FAIL** — `bun run lint` is nonzero. No production files were modified; the failure is reported, not suppressed or fixed.
