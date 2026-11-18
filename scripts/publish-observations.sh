#!/usr/bin/env bash
set -euo pipefail
term="${1:-WI27}"
if [[ ! "$term" =~ ^(WI|SP|FA|SU|SA|S[123])[0-9]{2}$ ]]; then
  echo "Invalid academic term" >&2
  exit 2
fi
root="$(git rev-parse --show-toplevel)"
destination="$(mktemp -d)"
if git ls-remote --exit-code --heads origin refs/heads/public-data >/dev/null; then
  git fetch --depth=1 origin refs/heads/public-data:refs/remotes/origin/public-data
  git worktree add -b public-data "$destination" refs/remotes/origin/public-data
else
  status=$?
  [[ $status -eq 2 ]] || exit "$status"
  git worktree add --detach --no-checkout "$destination" HEAD
  git -C "$destination" switch --orphan public-data
fi
(cd "$root/server" && go run . publish-observations "$term" "$destination")
git -C "$destination" config user.name 'github-actions[bot]'
git -C "$destination" config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git -C "$destination" add -- "$term"
if ! git -C "$destination" diff --cached --quiet; then
  git -C "$destination" commit -m "Observe $term public seat counts"
  git -C "$destination" push origin HEAD:refs/heads/public-data
fi
