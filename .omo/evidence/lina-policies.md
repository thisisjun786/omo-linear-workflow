# LINA policy adoption: settings and workflow changes for the owner

Commit `docs: adopt LINA repository policies` changes documentation only. The
rules below are documented but not yet enforced. Apply them by hand; nothing in
this commit changes GitHub settings or workflow behavior.

## Repository settings

1. Default branch: `dev`.
2. Pull requests: allow merge commits only. Disable "Allow squash merging" and
   "Allow rebase merging".
3. Ruleset or branch protection for `dev`: require a pull request before
   merging (0 required approvals; single-owner repo), require the `validate`
   status check from the CI workflow to pass, require branches to be up to
   date, block force pushes and deletion. No squash or rebase merge method.
4. Ruleset or branch protection for `main`: block force pushes and deletion,
   restrict pushes to the owner (or to the release workflow's token once it
   exists), and do not allow pull requests to target it. GitHub has no
   "reject PR target" toggle; enforce it through the release workflow
   change below and by restricting who can update `main`.
5. Security tab: enable private vulnerability reporting so SECURITY.md's
   primary route works.

## Workflow changes (separate PR into dev)

1. `ci.yml`: add `dev` to `on.push.branches` so a merge commit on `dev` gets its
   own run; that run is the exact-commit evidence a release should require.
2. `ci.yml`: add a metadata-only job that fails, and closes if the token
   allows, any `pull_request` whose `base.ref == 'main'`.
3. `release.yml`: keep the `v*` tag trigger and add a `workflow_dispatch`
   input for the exact `dev` commit SHA and tag; verify the SHA is on `dev`
   and has a successful CI run; after `gh release create`, fast-forward
   `main` to that SHA (`git push origin <sha>:refs/heads/main` with
   `--force-with-lease` disabled, fail on non-fast-forward). Restrict dispatch
   to the owner. Until then, docs/policy/releases.md step 7 has the owner do
   the fast-forward by hand.
4. Optionally add a docs link check (the script used here lived at
   /tmp/linkcheck.sh; it walks tracked `*.md` and checks each relative link
   target exists) as a CI step.

## Verification for this commit

- Relative link check over tracked Markdown: all resolve; script proven to
  fail on a planted broken link.
- `git diff --cached --check`: clean.
- `bun test tests/skills.test.ts`: 3 pass. `bun test`: 261 pass, 0 fail.
- `bun run lint`: exit 0.
- Issue template YAML parses.
