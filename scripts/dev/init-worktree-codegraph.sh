#!/usr/bin/env bash
# Initialize (or sync) a CodeGraph index for a git worktree.
#
# Worktrees under .worktrees/ are nested inside the main checkout. Without a
# local .codegraph/, the MCP server walks up and borrows the main repo index —
# stale symbols and wrong-branch results. Run this once per worktree after
# git worktree add.
#
# Usage:
#   scripts/dev/init-worktree-codegraph.sh              # current directory
#   scripts/dev/init-worktree-codegraph.sh <path>       # one worktree
#   scripts/dev/init-worktree-codegraph.sh --all        # all under .worktrees/
#   scripts/dev/init-worktree-codegraph.sh --sync <path>  # sync existing index
set -euo pipefail

resolve_codegraph_bin() {
  if command -v codegraph >/dev/null 2>&1; then
    command -v codegraph
    return 0
  fi
  local default="${HOME}/.omo/codegraph/bin/codegraph"
  if [[ -x "${default}" ]]; then
    echo "${default}"
    return 0
  fi
  echo "codegraph binary not found. Install CodeGraph or set PATH to include ~/.omo/codegraph/bin" >&2
  exit 1
}

require_git_root() {
  local dir="$1"
  if ! git -C "${dir}" rev-parse --show-toplevel >/dev/null 2>&1; then
    echo "Not a git working tree: ${dir}" >&2
    exit 1
  fi
}

init_worktree() {
  local dir="$1"
  local mode="${2:-init}" # init | sync
  local bin
  bin="$(resolve_codegraph_bin)"

  dir="$(cd "${dir}" && pwd)"
  require_git_root "${dir}"

  if [[ -e "${dir}/.codegraph" ]]; then
    if [[ "${mode}" == "sync" ]]; then
      echo "Syncing CodeGraph in ${dir}..."
      (cd "${dir}" && "${bin}" sync)
      return 0
    fi
    echo "Skipping ${dir} — .codegraph already exists (use --sync to refresh)"
    return 0
  fi

  echo "Initializing CodeGraph in ${dir}..."
  (cd "${dir}" && "${bin}" init -i)
  echo "Done: ${dir}"
}

init_all_worktrees() {
  local repo_root worktrees_dir wt
  repo_root="$(git rev-parse --show-toplevel)"
  worktrees_dir="${repo_root}/.worktrees"

  if [[ ! -d "${worktrees_dir}" ]]; then
    echo "No .worktrees/ directory at ${worktrees_dir}" >&2
    exit 1
  fi

  local count=0
  for wt in "${worktrees_dir}"/*/; do
    [[ -d "${wt}" ]] || continue
    init_worktree "${wt}" init
    count=$((count + 1))
  done

  if [[ "${count}" -eq 0 ]]; then
    echo "No worktrees found under ${worktrees_dir}"
  else
    echo "Processed ${count} worktree(s) under ${worktrees_dir}"
  fi
}

usage() {
  cat <<'EOF'
Usage:
  init-worktree-codegraph.sh [path]       Init index for one worktree (default: cwd)
  init-worktree-codegraph.sh --all        Init every worktree under .worktrees/
  init-worktree-codegraph.sh --sync [path]  Sync an existing index (default: cwd)

npm shortcuts:
  npm run codegraph:worktree -- [path]
  npm run codegraph:worktrees:all
EOF
}

main() {
  local mode="init"
  local target=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all)
        init_all_worktrees
        return 0
        ;;
      --sync)
        mode="sync"
        shift
        ;;
      -h|--help)
        usage
        return 0
        ;;
      -*)
        echo "Unknown option: $1" >&2
        usage >&2
        exit 1
        ;;
      *)
        target="$1"
        shift
        ;;
    esac
  done

  if [[ -z "${target}" ]]; then
    target="$(pwd)"
  fi

  init_worktree "${target}" "${mode}"
}

main "$@"