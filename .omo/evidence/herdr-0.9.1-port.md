# Herdr 0.9.1 OMO port evidence

## Result and source base

- Independent checkout: `/home/jun/code/herdr-omo-0.9.1`
- Canonical remote: `https://github.com/herdrdev/herdr.git`
- Read-only discovery: `git ls-remote --tags https://github.com/herdrdev/herdr.git 'refs/tags/v0.9.1' 'refs/tags/v0.9.1^{}'`
- Annotated tag object: `8544776216a8d28088db59a5344ea21ee2d05d2b`
- Peeled source commit / checkout HEAD: `065ef9d6a531c49fb8bee7e818ef837065b21ee9`
- Exact tag: `v0.9.1`
- Historical patch source: read-only dirty checkout `/home/jun/code/herdr-omo` at `b99002ac` (`v0.9.0`, branch `local/omo-0.9.0`). Its tracked diff and all untracked Senpi files were applied to the new checkout; it was not modified.

The port preserves the existing local OMO/Senpi implementation: canonical `omo` identity with legacy `senpi` manifest/storage identity, process and manifest detection, custom Senpi screen regions, local integration install/status handling without changing the frozen `IntegrationTarget` codec, persistence/config/sidebar handling, detached-eval integration assets, catalog checks, tests, and docs.

## Changed paths

```text
distribution/agent-detection/index.toml
distribution/agent-detection/senpi.toml
docs/next/website/src/content/docs/agent-automation.mdx
docs/next/website/src/content/docs/agents.mdx
docs/next/website/src/content/docs/cli-reference.mdx
docs/next/website/src/content/docs/integrations.mdx
docs/next/website/src/content/docs/ja/agent-automation.mdx
docs/next/website/src/content/docs/ja/agents.mdx
docs/next/website/src/content/docs/ja/cli-reference.mdx
docs/next/website/src/content/docs/ja/integrations.mdx
docs/next/website/src/content/docs/zh-cn/agent-automation.mdx
docs/next/website/src/content/docs/zh-cn/agents.mdx
docs/next/website/src/content/docs/zh-cn/cli-reference.mdx
docs/next/website/src/content/docs/zh-cn/integrations.mdx
docs/next/website/src/data/config-reference.json
justfile
scripts/agent_detection_manifest_check.py
scripts/test_agent_detection_manifest_check.py
src/cli/integration.rs
src/cli/spec.rs
src/config/model.rs
src/config/sidebar.rs
src/config/sound.rs
src/detect/manifest.rs
src/detect/manifest/senpi_regions.rs
src/detect/manifest/tests.rs
src/detect/manifest_update.rs
src/detect/manifests/senpi.toml
src/detect/mod.rs
src/integration/assets/senpi/herdr-agent-state.test.ts
src/integration/assets/senpi/herdr-agent-state.ts
src/integration/mod.rs
src/integration/senpi.rs
src/integration/senpi/tests.rs
src/persist/restore.rs
src/persist/snapshot.rs
```

## 0.9.1 adaptations versus the historical patch

- Preserved 0.9.1's Letta agent, CLI integration target, documentation, and CJK IME aliases while merging Senpi/OMO beside them.
- Updated `Agent::ALL` and `SCREEN_MANIFEST_AGENTS` sizes for the combined 0.9.1 agent set.
- Preserved 0.9.1's `Arc` manifest state and iteration shape while adding the Senpi region cache.
- Replaced a historical one-element test loop rejected by Rust 1.96.1 Clippy; behavior is unchanged.
- Added the new regression and minimal recognizer for normalized `node_modules/@code-yeongyu/senpi/dist/bundle/cli.js` paths. The regression uses the observed Bun plus OMO beta.84-style absolute argv and expects canonical `(Senpi, "omo")` identity.

## RED / GREEN evidence

Environment used Rust 1.96.1, cargo-nextest 0.9.146, just 1.46.0, Bun 1.4.0, and Zig 0.16.0. Long commands were bounded with `timeout` and captured with `tee`.

The workstation's non-login PATH needs this prefix to reproduce the checks:

```sh
export PATH=/home/jun/.cache/hermit/pkg/rustup-1.28.2:/home/jun/.cache/hermit/pkg/just-1.46.0:/home/jun/.cargo/bin:$PATH
```

RED, after the historical port compiled but before adding bundled-path recognition:

```bash
timeout 1200 just test-one identify_agent_in_job_detects_bun_wrapped_senpi_bundled_cli
```

Result: exit `100`; 1 test failed. The assertion reported `left: None`, `right: Some((Senpi, "omo"))`.

Targeted GREEN after the six-component normalized suffix recognizer:

```bash
timeout 1200 just test-one identify_agent_in_job_detects_bun_wrapped_senpi_bundled_cli
```

Result: exit `0`; 1 passed, 3705 skipped by the filter.

Required project gate:

```bash
LIBGHOSTTY_VT_WINDOWS_LIBC=/tmp/herdr-windows-cross-home/.local/share/herdr/windows-cross/libc.txt timeout 2400 just check
```

Result: exit `0`. Relevant totals: Clippy clean; 3700 nextest tests passed and 6 were suite-skipped; 124 maintenance tests passed; 6 UI architecture tests passed; integration assets passed including all 12 Senpi tests; Windows MSVC cross-target Clippy passed; 7 docs contract tests passed. The first `just check` attempt reached the Windows gate and exited `1` only because the workstation had no configured SDK. A temporary SDK was prepared under `/tmp/herdr-windows-cross-home` with `just setup-windows-cross --accept-license`; no Herdr user configuration was changed. There were no fixture or stable protocol invariant failures.

Release build:

```bash
timeout 2400 just build
```

Result: exit `0` (`cargo build --release --locked`).

The lead independently reran `just check && just build` with the PATH prefix
and Windows SDK variable above. Monitor `mon_DTVAQGKAX2XNRNFT` completed exit 0:
3700 tests passed, 6 existing suite exclusions, maintenance/integration/docs
checks and Windows Clippy passed, and the release build finished successfully.
The preceding lead attempt exited 127 before executing checks because `just`
was absent from its PATH; this was an environment setup failure.

The lead compared the old and new port diffs: changes beyond the original
patch are the documented 0.9.1 adaptations and bundled-entry recognition.
At that point the manifest, region parser and reporter assets were identical
to the old patch. The installed OMO reporter remains byte-identical to the
candidate asset.
No `src/protocol`, `src/api`, or frozen fixture diff exists.

## Lead fix for current OMO screen chrome

Real QA exposed a second version drift: beta.84 renders the working status
inside the editor's top border (`── • Working (... • esc to interrupt) ───`).
The historical region parser only recognized plain borders and a separate
status line.

`status_embedded_in_current_editor_border_is_live` first failed with an empty
status instead of `• Working (12s • esc to interrupt)` (monitor
`mon_J4Q0W8K1F9WPHA2R`, exit 100). The minimal fix borrows the status slice from
a validated current editor border and compares display width. A separate
negative regression keeps pasted, indented status text inactive.

After this fix, the lead ran `just ci && just docs-contract-test && just build`
(`mon_YJZTZMAR69BSR9BY`, exit 0): 3702 tests passed, 6 existing suite exclusions,
Clippy/formatting, maintenance, integration assets and docs passed; release
build passed. Rust LSP was unavailable, so compiler and Clippy diagnostics
were used. Windows cross-Clippy passed on the initial port before this final,
platform-neutral parser change; it was not rerun afterward. The owned temporary
Windows SDK and patch-copy directory were removed.

## Binary receipt

- Path: `/home/jun/code/herdr-omo-0.9.1/target/release/herdr`
- `--version`: `herdr 0.9.1`
- Size: `26761456` bytes
- SHA-256: `e259912d271a2c014fcc6ae7f9845409feeb0204191735b2a982952ba6eec88f`

## Lead QA and installation

The lead completed the real OMO working-to-done and reporter wire checks in an
isolated named server; see [herdr-detection-qa.md](herdr-detection-qa.md).
The final binary above was installed after backup. The existing default server
and user workspaces were not restarted; see [herdr-installation.md](herdr-installation.md).
No user configuration, reporter asset, or existing source checkout was changed.
The reporter test exercises its real event handler and socket report/release,
not a model-generated detached computation.
