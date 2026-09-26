#!/usr/bin/env bash
set -euo pipefail

phase=${1:-}
if [[ "$phase" != validate && "$phase" != publish ]]; then
  echo 'usage: scripts/release-publish.sh validate|publish' >&2
  exit 2
fi

: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${RELEASE_VERSION:?RELEASE_VERSION is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RELEASE_NOTES_FILE:?RELEASE_NOTES_FILE is required}"

if [[ ! "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Release SHA must be a full lowercase 40-character commit SHA.' >&2
  exit 1
fi
RELEASE_VERSION=${RELEASE_VERSION#v}
if [[ ! "$RELEASE_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$ ]]; then
  echo 'Release version must be SemVer, optionally followed by -rc.N.' >&2
  exit 1
fi

release_tag="v$RELEASE_VERSION"

validate_release() {
  git fetch --force --prune --tags origin dev main
  git merge-base --is-ancestor "$RELEASE_SHA" origin/dev || {
    echo 'Release SHA is not an ancestor of origin/dev.' >&2
    exit 1
  }
  git merge-base --is-ancestor origin/main "$RELEASE_SHA" || {
    echo 'Release SHA cannot fast-forward origin/main.' >&2
    exit 1
  }

  if git show-ref --verify --quiet "refs/tags/$release_tag"; then
    tag_sha=$(git rev-parse "refs/tags/$release_tag^{commit}")
    if [[ "$tag_sha" != "$RELEASE_SHA" ]]; then
      echo "Tag $release_tag already points to another commit." >&2
      exit 1
    fi
  fi

  if [[ "$(git rev-parse HEAD)" != "$RELEASE_SHA" ]]; then
    echo 'The checkout does not match the requested release SHA.' >&2
    exit 1
  fi
  runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?event=push&branch=dev&head_sha=$RELEASE_SHA&per_page=100")
  jq -e --arg sha "$RELEASE_SHA" '
    any(.workflow_runs[];
      .head_sha == $sha and .head_branch == "dev" and .event == "push" and
      .status == "completed" and .conclusion == "success")
  ' <<<"$runs" >/dev/null || {
    echo 'No successful CI push run exists for this exact dev commit.' >&2
    exit 1
  }
  rm -f "$RELEASE_NOTES_FILE"
  bun scripts/release.ts --tag "$release_tag" --notes-file "$RELEASE_NOTES_FILE"
}

validate_release
if [[ "$phase" == validate ]]; then
  exit 0
fi

: "${RELEASE_TOKEN:?RELEASE_TOKEN is required for publication}"
auth=$(printf 'x-access-token:%s' "$RELEASE_TOKEN" | base64 -w0)
git_push() {
  git -c "http.extraheader=AUTHORIZATION: basic $auth" push "$@"
}

if ! git show-ref --verify --quiet "refs/tags/$release_tag"; then
  git -c user.name='github-actions[bot]' \
    -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    tag -a "$release_tag" -m "$release_tag" "$RELEASE_SHA"
  git_push origin "refs/tags/$release_tag"
fi

if release=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$release_tag"); then
  jq -e --arg sha "$RELEASE_SHA" '.draft == false and .target_commitish == $sha' <<<"$release" >/dev/null || {
    echo "An incompatible GitHub release already exists for $release_tag." >&2
    exit 1
  }
else
  jq -e '.status == "404"' <<<"$release" >/dev/null || {
    echo "Could not determine whether a GitHub release exists for $release_tag." >&2
    exit 1
  }
  args=(--verify-tag --target "$RELEASE_SHA" --title "$release_tag" --notes-file "$RELEASE_NOTES_FILE")
  if [[ "$RELEASE_VERSION" == *-rc.* ]]; then
    args+=(--prerelease)
  fi
  gh release create "$release_tag" "${args[@]}"
fi

git_push origin "$RELEASE_SHA:refs/heads/main" || {
  echo 'The release exists, but main was not updated. Inspect the branch and rerun this release.' >&2
  exit 1
}
