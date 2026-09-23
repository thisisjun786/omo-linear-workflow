# Managed Herdr runtime

Herdr is a required OLW runtime, not a separate optional installation. The normal
`bun run build` prepares it before replacing TypeScript build outputs. A verified
cached artifact is reused without downloading source or invoking a compiler.

## Pinned inputs

`manifest.json` records the upstream repository, full commit SHA, version,
Rust toolchain, Zig version, patch path and SHA256. The OMO/Senpi detection and
integration patch includes both previously tracked edits and seven new source
files from the working 0.9.1 port. `LICENSE` is upstream's Apache-2.0 license;
the vendored Herdr material retains that license.

Current inputs:

- Upstream: https://github.com/herdrdev/herdr.git
- Commit: `065ef9d6a531c49fb8bee7e818ef837065b21ee9`
- Herdr: `0.9.1`
- Rust: `1.96.1`, with rustfmt
- Zig: `0.16.0`
- Patch: `patches/herdr-0.9.1-omo.patch`

The reference binary digest records the previously working installation. It is
provenance, not a promise that unrelated platforms produce identical binaries.
The receipt's binary digest is always checked against the actual artifact.

## Build and use

```sh
pnpm install
bun run build
bun run herdr --version
bun run cli doctor --json
```

The first build needs Git, Rustup and Zig. `CARGO` may specify the Rustup Cargo
executable, and `ZIG` may specify the Zig executable. Compiler/tool versions are
checked before source preparation. Cargo runs with the pinned toolchain,
`--locked`, a repository-owned target directory, and at most eight jobs by
default; an explicit `CARGO_BUILD_JOBS` is honored.

Build steps:

1. Verify the tracked patch digest.
2. Fetch the exact upstream commit into a new owned staging directory.
3. Check and apply the patch, then publish the prepared source directory.
4. Check Rust formatting, run the 59 currently matching Senpi Rust tests, and
   run the 12 Senpi integration-asset tests.
5. Build the release binary and verify its reported version.
6. Publish the executable, license and build receipt atomically.

`bun run herdr:build` performs only this Herdr phase. `bun run herdr` forwards
arguments and terminal I/O to the verified managed binary. For example,
`bun run herdr status server` inspects the current server.

Generated source, target cache and binaries live under ignored `.omo/herdr/`.
The executable is selected by manifest identity plus platform/architecture;
normal TypeScript rebuilds do not remove it. Do not hand-edit generated source
or artifacts. Build failures do not publish a usable receipt and do not replace
the existing TypeScript distribution.

## Updates and rollback

To update, prepare and review a new full upstream commit and patch, update its
digest and tool versions in the manifest, then run `bun run build` and the
relevant runtime checks. Do not use upstream self-update to replace the managed
artifact outside this contract: a modified executable will fail digest checks.

Previous version directories are retained. Restore the previous matching
manifest and patch to select a prior verified artifact, or rebuild it from those
inputs if its cache was removed. There is no automatic PATH fallback.

A damaged executable/receipt or a leftover partial artifact directory is rejected,
not automatically overwritten. Re-running `herdr:build` alone does not repair an
occupied invalid cache directory. Inspect the affected version directory under
`.omo/herdr/bin/`, move that directory to a uniquely named recovery location,
then run `bun run herdr:build` again. Keep the quarantined files until the rebuilt
artifact is verified. Do not move the entire cache or an unrelated version; this
procedure does not stop an already running server.

Changing an executable on disk does not replace an already running Herdr server.
Inspect its status separately and arrange a restart or handoff only when the user
requests it. OLW does not close existing workspaces or rewrite existing binding
identities as part of a build.

The runtime resolver and role-launch tests use owned fixtures. Isolated QA may
explicitly override its server with `QA_HERDR_BINARY`, but defaults to this managed
runtime. A current-server smoke test is still required when making claims about
the user's active Herdr, and routing success alone does not establish autonomous
TUI lifecycle behavior.
