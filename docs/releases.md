# Versioning and releases

This document explains how OLW versions are numbered, how a maintainer cuts a
release, and how a user installs, upgrades or rolls back a source checkout.
Nothing here runs automatically on your machine; the steps are described so
they can be reviewed before anyone follows them.

The GitHub repository is public; `private: true` in `package.json` prevents npm
publication. Releases currently provide no prebuilt binary or artifact signing. A release is a reviewed, tagged
source tree plus a GitHub release entry that points at it.

## Version numbers

`package.json` `version` is the single canonical version. Nothing else in the
repository should claim a different one. The first release is `0.1.0`; consult
[GitHub Releases](https://github.com/thisisjun786/omo-linear-workflow/releases)
for published versions.

Versions follow SemVer `MAJOR.MINOR.PATCH`, optionally followed by `-rc.N`
where `N` is a positive integer. Git tags are the version with a `v` prefix:
`v0.1.0`, `v0.2.0-rc.1`.

While the major version is `0`:

- A **minor** bump may break documented contracts: CLI flags, exit codes, the
  SQLite schema, stored state layout, the scope snapshot format, the readiness
  and receipt protocol, or the proxy extension's configuration files. Any such
  break must ship with migration instructions in the changelog entry.
- A **patch** bump is backwards-compatible. Existing state, bindings and
  configuration keep working without user action.
- A **release candidate** (`-rc.N`) is a preview of the next version. It is
  marked as a prerelease on GitHub and may be superseded by a later RC or the
  final version.

Dependency pins have their own version lines and are not part of the OLW
version. The managed Herdr pin lives in `vendor/herdr/manifest.json` and its
patch; OMO, Senpi and other packages are pinned in `package.json` and
`pnpm-lock.yaml`. Changing a pin is a normal change that gets a changelog entry
under whichever OLW version ships it. The Herdr update and rollback procedure is
in [vendor/herdr/README.md](../vendor/herdr/README.md).

## Changelog contract

[CHANGELOG.md](../CHANGELOG.md) always has an `## [Unreleased]` section at the
top. User-facing changes land there as they merge.

When a version is prepared, the maintainer moves the Unreleased notes into a
`## [VERSION]` heading that matches `package.json` exactly, and adds
`Released: YYYY-MM-DD` as the first line of the body. The heading itself carries
no date or suffix; every `##` heading in the file must be `[Unreleased]` or a
bare `[VERSION]`. `bun run release:check` reads that section: if the heading is
missing, malformed, duplicated or empty, the check fails and the release stops
there.
The check can also be pointed at a specific tag and a separate notes file with
`--tag vVERSION --notes-file PATH` to validate the tag and extract that exact
changelog section into a new file. It does not rewrite or customize the notes.

Breaking changes in a `0.x` minor get a `### Migration` subsection that tells an
operator, step by step, what to run or edit before using the new version.

## Cutting a release (maintainer)

These are the manual steps. None of them run on their own, and none should be
skipped because "it's just a patch".

1. Confirm `main` is green: `bun test`, `bun run typecheck`, `bun run lint`,
   `bun run build`. Run the isolated QA scripts that cover what changed.
2. Decide the version using the rules above. Update `package.json` `version`.
3. Move `## [Unreleased]` notes into `## [VERSION]`, add the `Released:` line,
   write the migration subsection if anything breaks. Leave an empty `## [Unreleased]`
   behind.
4. Check both READMEs still describe the code being released.
5. Run `bun run release:check` locally and fix whatever it reports.
6. Commit as a Conventional Commit, for example `chore(release): v0.2.0`, open
   a PR, get it reviewed and merged with green checks.
7. Tag the merge commit: `git tag -a v0.2.0 -m "v0.2.0"` and push the tag.
8. Pushing a `v*` tag triggers the release workflow. It reruns validation and
   the native Herdr build on Linux, then creates a source-only GitHub release
   from the changelog section. Tags containing `-rc.` are marked prerelease.
9. Watch the workflow. Retry a transient infrastructure failure at the same
   immutable tag. If a source fix is needed, merge it and prepare a new version
   and tag instead of moving the failed tag. Never move a published tag.

Nothing is published to npm. The release workflow doesn't attach binaries and
doesn't sign anything.

## Installing from a release (user)

Pick a tag or the source archive of a GitHub release. Cloning the tag is the
recommended path because upgrades and rollbacks then become `git checkout`.

```sh
git clone --branch v0.1.0 https://github.com/thisisjun786/omo-linear-workflow.git ~/code/omo-linear-workflow
cd ~/code/omo-linear-workflow
bun run install:local
```

Add `--bin-dir PATH` if you want the launcher somewhere other than the default.
The installer checks for Bun 1.4.0 or newer, pnpm 10.33.3, Node 24.20 and
`git`, and reports what is missing. It doesn't install those for you. The first
uncached build also needs Rust 1.96.1 with `rustfmt` from Rustup and Zig
0.16.0 for the managed Herdr. Linux x64 is the only supported target.

The example selects the first release. Choose another published tag to install
that version, or omit `--branch v0.1.0` to install a reviewed `main` commit.

If you download a source archive, unpack it to a stable path and run the same
command inside it. Proxy access files are outside the checkout by default, but
the registry and managed runtime live inside its ignored `.omo/` directory.
Never replace or delete that directory during an upgrade. Back up the full
control root before replacing an archive checkout; a Git clone is recommended
because switching tags preserves ignored state and the launcher's stable path.

The installer won't edit your shell profile, change accounts or proxy policy,
overwrite a launcher it doesn't own, restart running sessions or update
itself. Read the README for the exact behavior and don't expect flags that
aren't listed there.

## Upgrading

Upgrade by moving the checkout to a reviewed version and running the installer
again.

```sh
cd ~/code/omo-linear-workflow
git fetch --tags
git checkout v0.2.0
bun run install:local
```

Before you switch:

- Read the `## [0.2.0]` changelog section. If it has a `### Migration`
  subsection, do those steps in the order written.
- Finish or `pause` active role bindings if the notes say the runtime changes.
  An upgrade doesn't restart existing Herdr servers or OMO sessions on its
  own; running sessions keep the old code until they are closed and recreated.
- If the Herdr pin changed, the next `bun run build` compiles Herdr again.
  Existing servers aren't replaced; see the vendor README for handoff.

Skipping versions is fine as long as you apply each intermediate migration
subsection in order.

## Rolling back

Rolling back is the same motion in reverse: check out the previous tag and
reinstall.

```sh
cd ~/code/omo-linear-workflow
git checkout v0.1.0
bun run install:local
```

Runtime state survives a rollback. SQLite registries, `.omo/state/`, worktrees
and branches, Herdr artifact caches and your proxy access files are not touched
by the installer or by `git checkout`. The previous Herdr artifact directory is
retained, so a rollback that restores the old manifest selects it without a
rebuild if the cache is still present.

Compatibility caveats:

- Patch releases must preserve stored-data and protocol compatibility in both
  directions. Check the release notes and retained backup before rollback;
  this policy is not a guarantee against an undiscovered release defect.
- Rolling back across a `0.x` minor that migrated data is not guaranteed.
  Migrations run forward only; there is no automated reverse migration. If
  the newer version rewrote the SQLite schema or state layout, the older code
  may refuse to open it or misread it. Back up the control root before a minor
  upgrade if you think you might need to come back.
- Bindings created under the newer version keep the model, provider and
  reasoning recorded at their first session. Older code reads them as stored
  and does not rewrite them.
- Running Herdr servers and OMO sessions are not affected by checking out a
  different version. Close and recreate roles when you actually need them on
  the rolled-back code.

## Uninstalling

Inspect and remove only the `olw` launcher created at the recorded bin directory.
It is the only file the installer creates outside the checkout; there is no
uninstall command that removes another installation or cleans runtime state.
The checkout, its `.omo/` state and your access files stay in place; delete
them yourself if you want them gone.
