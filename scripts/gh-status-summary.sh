#!/usr/bin/env bash
# =============================================================================
# gh-status-summary.sh — mobile status monitoring, layer 2 (2026-10-29 plan)
#
# One pass over a list of product repositories, printing, per repository:
#   * open PRs with their merge-gate verdict (MERGEABLE/BLOCKED/CLEAN/…)
#   * the latest Actions runs with status/conclusion
#   * local git branch sync (ahead/behind) when a clone exists under the repo name
#
# Use it from the phone via the desktop remote-control link: "汇总一下我的仓库
# git/PR/CI 状态" -> desktop runs this script and returns the table.
#
# Repository list: positional arguments (owner/repo), or a file with one repo per
# line. Default file: ~/.config/pr-helper/repos.txt  (override: PR_HELPER_REPOS_FILE)
# =============================================================================
set -euo pipefail

repos_file="${PR_HELPER_REPOS_FILE:-$HOME/.config/pr-helper/repos.txt}"

if [[ $# -gt 0 ]]; then
  repos=("$@")
elif [[ -f "$repos_file" ]]; then
  repos=()
  while IFS= read -r line; do repos+=("$line"); done < "$repos_file"
else
  echo "用法: $0 [owner/repo ...]" >&2
  echo "或创建 ${repos_file}，每行一个 owner/repo" >&2
  exit 1
fi

command -v gh >/dev/null 2>&1 || { echo "需要 GitHub CLI (gh)" >&2; exit 1; }

for repo in "${repos[@]:-}"; do
  [[ -z "$repo" ]] && continue
  case "$repo" in \#*) continue ;; esac
  echo "==== $repo ===="
  if ! gh repo view "$repo" --json nameWithOwner -q .nameWithOwner >/dev/null 2>&1; then
    echo "  gh 无法访问 $repo（不存在或未授权）"
    echo ""
    continue
  fi

  echo "-- PR（开放）--"
  gh pr list -R "$repo" --state open --limit 8 --json number,title,isDraft,mergeStateStatus \
    --jq '.[] | "  #\(.number) [\(.mergeStateStatus)]\(if .isDraft then " [draft]" else "" end) \(.title)"' 2>/dev/null \
    || echo "  (gh pr list 失败)"
  open_prs="$(gh pr list -R "$repo" --state open --limit 1 --json number --jq 'length' 2>/dev/null || echo 0)"
  echo "  开放 PR 数: ${open_prs}"

  echo "-- CI（最近 3 次运行）--"
  gh run list -R "$repo" --limit 3 --json displayTitle,status,conclusion,event \
    --jq '.[] | "  \(.status)/\(.conclusion) (\(.event)) \(.displayTitle)"' 2>/dev/null \
    || echo "  (gh run list 失败)"
  latest_conclusion="$(gh run list -R "$repo" --limit 1 --json conclusion --jq '.[0].conclusion' 2>/dev/null || echo unknown)"
  echo "  最近结论: ${latest_conclusion}"

  echo "-- git（本地 clone 存在时）--"
  if [[ -d "$repo/.git" ]]; then
    (
      cd "$repo"
      git fetch --quiet --prune origin 2>/dev/null || true
      git status -sb | head -3
      current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
      if git rev-parse --verify "${current}@{upstream}" >/dev/null 2>&1; then
        ahead_behind="$(git rev-list --left-right --count "${current}@{upstream}...HEAD" 2>/dev/null || echo '? ?')"
        echo "  ${current} vs upstream (behind/ahead): ${ahead_behind}"
      fi
    )
  else
    echo "  无本地 clone（仓库路径为 ${repo}），跳过 git 状态"
  fi
  echo ""
done
