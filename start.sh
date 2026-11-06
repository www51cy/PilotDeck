#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PINNED_NODE_BIN="$HOME/.local/share/pilotdeck-node/node-v22.13.0-linux-x64/bin"
LOG_FILE="$ROOT_DIR/tmp/dev-server.log"

if [[ -x "$PINNED_NODE_BIN/node" ]]; then
  export PATH="$PINNED_NODE_BIN:$PATH"
fi
mkdir -p "$ROOT_DIR/tmp"

existing_pids=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  if [[ "$process_cwd" == "$ROOT_DIR" ]]; then
    existing_pids+=("$pid")
  fi
done < <(pgrep -f 'node scripts/dev-launcher\.mjs' || true)

if ((${#existing_pids[@]} > 0)); then
  own_pgid="$(ps -o pgid= -p $$ | tr -d '[:space:]')"
  for pid in "${existing_pids[@]}"; do
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$pgid" =~ ^[0-9]+$ && "$pgid" != "$own_pgid" ]]; then
      kill -TERM -- "-$pgid" 2>/dev/null || true
    else
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  for pid in "${existing_pids[@]}"; do
    for ((attempt = 0; attempt < 100; attempt++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      printf '旧 PilotDeck 进程未在 10 秒内退出：%s\n' "$pid" >&2
      exit 1
    fi
  done
fi

setsid env -C "$ROOT_DIR" npm run dev > "$LOG_FILE" 2>&1 < /dev/null &
printf 'PilotDeck 已发起启动，PID：%s\n日志：%s\n' "$!" "$LOG_FILE"
