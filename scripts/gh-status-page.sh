#!/usr/bin/env bash
# =============================================================================
# gh-status-page.sh — mobile status monitoring, layer 3 (2026-10-29 plan)
#
# Generates a self-contained, phone-friendly status page: one card per product
# repository with PR list + gate verdict, latest CI run verdict and local git
# sync, auto-refreshing. Open it in the phone browser ("扫一眼"), or re-run it
# from the desktop via the remote-control link whenever you want fresh data.
#
# Data is captured once at generation time and inlined into the HTML, so the
# page works from any static host or even file:// — no tokens in the browser.
#
# Repository list: positional arguments (owner/repo), or a file with one repo
# per line. Default file: ~/.config/pr-helper/repos.txt
# Environment overrides:
#   PR_HELPER_REPOS_FILE    repo list file (default ~/.config/pr-helper/repos.txt)
#   PR_HELPER_STATUS_OUTPUT output path   (default status/index.html)
#   PR_HELPER_STATUS_REFRESH auto-refresh seconds (default 300; 0 disables)
# =============================================================================
set -euo pipefail

repos_file="${PR_HELPER_REPOS_FILE:-$HOME/.config/pr-helper/repos.txt}"
output="${PR_HELPER_STATUS_OUTPUT:-status/index.html}"
refresh="${PR_HELPER_STATUS_REFRESH:-300}"

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

esc_html() { jq -rn --arg v "$1" '$v | @html'; }

cards=""
for repo in "${repos[@]:-}"; do
  [[ -z "$repo" ]] && continue
  case "$repo" in \#*) continue ;; esac
  repo_esc=$(esc_html "$repo")
  if ! gh repo view "$repo" --json nameWithOwner -q .nameWithOwner >/dev/null 2>&1; then
    cards+="<article class=\"repo is-unknown\"><h2>${repo_esc}</h2><p class=\"note\">gh 无法访问（不存在或未授权）</p></article>"
    continue
  fi

  ci_conclusion="$(gh run list -R "$repo" --limit 1 --json conclusion --jq '.[0].conclusion' 2>/dev/null || echo unknown)"
  ci_status="$(gh run list -R "$repo" --limit 1 --json status --jq '.[0].status' 2>/dev/null || echo unknown)"
  if [[ "$ci_conclusion" == "failure" || "$ci_conclusion" == "cancelled" ]]; then
    ci_badge="is-failed"
    ci_text="CI ${ci_conclusion}"
  elif [[ "$ci_conclusion" == "success" ]]; then
    ci_badge="is-ok"
    ci_text="CI success"
  elif [[ "$ci_status" == "in_progress" || "$ci_status" == "queued" ]]; then
    ci_badge="is-pending"
    ci_text="CI ${ci_status}"
  else
    ci_badge="is-pending"
    ci_text="CI ${ci_conclusion:-unknown}"
  fi

  pr_count="$(gh pr list -R "$repo" --state open --limit 1 --json number --jq 'length' 2>/dev/null || echo 0)"
  if [[ "${pr_count}" -gt 0 ]]; then
    pr_badge="is-open"
    pr_text="${pr_count} 个开放 PR"
  else
    pr_badge="is-idle"
    pr_text="无开放 PR"
  fi

  prs_html=""
  if [[ "${pr_count}" -gt 0 ]]; then
    prs_html="$(gh pr list -R "$repo" --state open --limit 6 --json number,title,isDraft,mergeStateStatus \
      --jq '.[] | "<li data-gate=\"\(.mergeStateStatus)\">#\(.number) [\(.mergeStateStatus)]\(if .isDraft then " [draft]" else "" end) \(.title)</li>"' 2>/dev/null || true)"
  fi

  runs_html="$(gh run list -R "$repo" --limit 3 --json displayTitle,status,conclusion \
    --jq '.[] | "<li data-verdict=\"\(if .conclusion == "failure" then "fail" elif .conclusion == "success" then "ok" elif .status == "in_progress" or .status == "queued" then "run" else "other" end)\">\(.status)/\(.conclusion) \(.displayTitle)</li>"' 2>/dev/null || true)"

  git_html=""
  if [[ -d "$repo/.git" ]]; then
    branch="$(cd "$repo" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    branch_esc=$(esc_html "${branch}")
    ahead_behind=""
    if (cd "$repo" && git rev-parse --verify "${branch}@{upstream}" >/dev/null 2>&1); then
      ahead_behind="$(cd "$repo" && git rev-list --left-right --count "${branch}@{upstream}...HEAD" 2>/dev/null || echo '? ?')"
    fi
    if [[ -n "$ahead_behind" ]]; then
      behind="${ahead_behind%% *}"
      ahead="${ahead_behind##* }"
      git_html="<li>分支 <b>${branch_esc}</b> · behind ${behind} / ahead ${ahead}</li>"
    else
      git_html="<li>分支 <b>${branch_esc}</b></li>"
    fi
  else
    git_html="<li class=\"note\">无本地 clone，跳过 git 状态</li>"
  fi

  cards+="<article class=\"repo\"><h2>${repo_esc}</h2><div class=\"badges\"><span class=\"badge ${ci_badge}\">${ci_text}</span><span class=\"badge ${pr_badge}\">${pr_text}</span></div><h3>PR</h3><ul class=\"prs\">${prs_html:-<li class=\"note\">无</li>}</ul><h3>CI 最近运行</h3><ul class=\"runs\">${runs_html:-<li class=\"note\">无</li>}</ul><h3>git</h3><ul class=\"git\">${git_html}</ul></article>"
done

generated_at="$(date '+%Y-%m-%d %H:%M:%S %z')"
mkdir -p "$(dirname "$output")"

meta_refresh=""
if [[ "$refresh" -gt 0 ]]; then meta_refresh="<meta http-equiv=\"refresh\" content=\"${refresh}\" />"; fi

cat > "$output" <<HTML
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PR Helper · 仓库状态</title>
${meta_refresh}
<style>
:root { --bg:#0f1115; --card:#171a21; --line:#262b36; --text:#e8eaed; --muted:#8b93a1; --ok:#2ea86b; --fail:#e5484d; --pending:#d29922; --open:#4c8dff; }
* { box-sizing:border-box; }
body { margin:0; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--text); padding:16px; }
h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:17px; margin:0 0 10px; } h3 { font-size:13px; margin:18px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
header { margin-bottom:14px; } .updated { color:var(--muted); font-size:13px; }
.repos { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr)); gap:12px; }
.repo { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; }
.repo.is-unknown { opacity:.7; }
.badges { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.badge { font-size:12px; font-weight:600; padding:3px 10px; border-radius:999px; }
.badge.is-ok { background:rgba(46,168,107,.15); color:var(--ok); } .badge.is-failed { background:rgba(229,72,77,.15); color:var(--fail); }
.badge.is-pending { background:rgba(210,153,34,.15); color:var(--pending); } .badge.is-open { background:rgba(76,141,255,.15); color:var(--open); }
.badge.is-idle { background:rgba(139,147,161,.15); color:var(--muted); }
ul { list-style:none; margin:0; padding:0; } li { padding:4px 0; border-bottom:1px dashed var(--line); font-size:14px; }
li:last-child { border-bottom:0; } li[data-gate="BLOCKED"], li[data-verdict="fail"] { color:var(--fail); }
li[data-gate="MERGEABLE"], li[data-verdict="ok"] { color:var(--ok); } li[data-verdict="run"] { color:var(--pending); }
.note { color:var(--muted); }
a.refresh { display:inline-block; margin-top:12px; color:var(--open); text-decoration:none; font-size:14px; }
</style>
</head>
<body>
<header><h1>PR Helper · 仓库状态</h1><p class="updated">生成于 ${generated_at} · <a class="refresh" href="javascript:location.reload()">手动刷新</a></p></header>
<div class="repos">${cards}</div>
</body>
</html>
HTML

echo "已生成 ${output}（${#repos[@]} 个仓库，${generated_at}，自动刷新 ${refresh}s）"
