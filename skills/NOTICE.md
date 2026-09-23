# Provenance and license

The four skills under `skills/{define,plan,run,check}` and the shared references under
`skills/references/` are compact adaptations of the CRW workflow skills:

- Upstream: `https://github.com/thisisjun786/codex-relay-workflow`
- Pinned revision: `90b1a86d894c5cac55a73a0a6b0735955acda4bb` (plugin `crw` 0.2.0)
- Adapted files: `plugins/crw/skills/crw-define/SKILL.md`, `crw-plan/SKILL.md`,
  `crw-run/SKILL.md`, `crw-check/SKILL.md`, `crw-plan/references/integrations.md`,
  `crw-run/references/initiative-supervision.md`, `crw-run/references/operations.md`

What was ported is the policy: role ownership, definition versus execution approval, report
versus integration, stable IDs, and no goal loops or polling. The Codex runtime pieces
(`codex-thread-bridge`, `codex-session-relay`, `crw-loop`, hooks and wiring) were not ported.
Cross-session delivery here uses OMO's native thread tools through the orchestrator in this
repository. Skill names were changed to `olw-define`, `olw-plan`, `olw-run` and `olw-check` so they
can coexist with an installed CRW plugin.

## Upstream license (MIT)

```
MIT License

Copyright (c) 2026 thisisjun786 and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
