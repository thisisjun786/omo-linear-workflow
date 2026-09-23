# Managed Herdr integration

Completed on 2026-09-23. OLW now owns the working Herdr source/patch/build contract
and treats the resulting executable as a required runtime, not an optional PATH
dependency.

## Provenance

- Upstream: `https://github.com/herdrdev/herdr.git`
- Commit: `065ef9d6a531c49fb8bee7e818ef837065b21ee9`
- Herdr version: `0.9.1`
- Rust: `1.96.1`; Zig: `0.16.0`
- Patch: `patches/herdr-0.9.1-omo.patch`
- Patch SHA256: `ac3229248130ce3d3d9121e1a29b6204732c14a15829c5bb94b0fb8653732168`
- Manifest identity: `20c94cc2b63ebb34a0da254469c66a81a97ea3d6a4649b42a58fc1d8477c4efa`
- Built binary SHA256: `e259912d271a2c014fcc6ae7f9845409feeb0204191735b2a982952ba6eec88f`

The patch includes the 29 tracked-file changes and all seven new files from
`/home/jun/code/herdr-omo-0.9.1`. It was applied with `git apply --check` followed
by `git apply` to a fresh fetch of the exact upstream commit. Neither that source
tree nor the obsolete `/home/jun/code/herdr-omo` tree was edited.

The rebuilt executable's digest exactly matches the existing
`/home/jun/.local/bin/herdr`, the original port's release executable, and the
running default server's `/proc/1746888/exe`. No global executable replacement,
server restart or workspace migration was required.

## Build verification

Cold build:

```sh
CARGO=/home/jun/.cache/hermit/pkg/rustup-1.28.2/cargo bun run herdr:build
```

Monitor `mon_4TEHPF1VHED64ZFJ` exited 0:

- Rust formatting passed.
- Focused Senpi Rust tests: 59 passed, 0 failed.
- Senpi integration-asset tests: 12 passed, 0 failed.
- Release build passed.
- Version probe returned `herdr 0.9.1`.
- Receipt publication and executable SHA256 verification passed.

The first attempt failed because the explicitly located Cargo directory was not
in PATH for `cargo-fmt`. The builder now includes the selected Cargo and Zig
directories in its subprocess PATH. No upstream source change was needed.
The upstream build script prints its existing external-contributor notice;
there were no Rust compilation errors. The full unrelated Rust suite was not
rerun.

Builder regressions first showed that a missing managed artifact did not perform
toolchain preflight. After implementation, cache reuse, unavailable compiler,
and mismatched Cargo version tests passed. Runtime tests cover patch tampering,
escaping paths, full commit pins, receipt mismatch, executable digest mismatch,
no PATH fallback, argument forwarding, and role/shared-host PATH selection.

## Current-server smoke test

This test used the current default Herdr, not an isolated substitute:

1. Recorded the five existing workspace IDs and focus `w47`.
2. Used the managed executable to create background workspace `w4C`, pane
   `w4C:p1`, with `--no-focus` and an owned temporary CWD.
3. Armed native `pane wait-output` through monitor `mon_PX1XSB5VXQKEH0XF`.
4. In that pane, prepended the managed binary directory to PATH, asserted
   `command -v herdr` selected that exact binary, and executed `herdr --version`
   plus `herdr status server`.
5. Emitted a randomly generated sentinel only after those commands succeeded.
   The command contained only its base64 encoding, so echoed input could not
   satisfy the output wait.
6. Received `output_matched`, exit 0. Server status reported version 0.9.1,
   endpoint compatibility, and private protocol 22 compatibility.
7. Closed only `w4C`, removed only its temporary CWD, and verified the original
   five workspace IDs and focus `w47` were unchanged.

This proves current-server creation, managed executable selection, pane command
execution, server communication, observed output, and cleanup. It does not
claim a fresh autonomous OMO TUI/hierarchy lifecycle run.

## OLW integration

- Normal `bun run build` verifies/reuses Herdr before replacing `dist/`.
- `bun run herdr` uses the verified managed executable.
- Doctor reports that artifact rather than resolving a global PATH binary.
- New role TUI/shared-host launches prepend the managed binary directory.
- Existing binding identity, server selection and running sessions are retained.
- QA control roots copy the manifest, patch and verified artifact. Their default
  server is managed; `QA_HERDR_BINARY` is an explicit test override.

Monitor `mon_MCXQZP6PR5Q7AVDN` verified 82 Bun tests, strict type checking, lint,
normal build, wrapper version output and doctor, exit 0. A separate QA-world
setup/cleanup probe (`mon_F5PM931QHBNQ6V51`) resolved the copied artifact and
reported successful cleanup. The final regression run is recorded in the
coordinating session under `mon_24ZVKSJ40HSQXFE2`.

Sources and operational instructions are in `vendor/herdr/README.md`.
Generated sources, Cargo cache and receipts are contained under `.omo/herdr/`.
The original verification recorded here made no repository commit or upstream publication;
subsequent integration commits preserve this evidence as a historical receipt.
