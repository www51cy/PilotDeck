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
launcher_pid=$!
printf 'PilotDeck 已发起启动，PID：%s\n日志：%s\n' "$launcher_pid" "$LOG_FILE"

names=("前端" "后端路由" "无头服务")
urls=(
  "http://127.0.0.1:5173/"
  "http://127.0.0.1:3001/"
  "http://127.0.0.1:18789/"
)
http_codes=("000" "000" "000")
deadline=$((SECONDS + 120))

while ((SECONDS < deadline)); do
  all_ready=1
  for index in "${!urls[@]}"; do
    [[ "${http_codes[$index]}" == "200" ]] && continue
    http_codes[$index]="$(curl --noproxy '*' --silent --output /dev/null \
      --connect-timeout 1 --max-time 3 --write-out '%{http_code}' \
      "${urls[$index]}" || true)"
    if [[ "${http_codes[$index]}" != "200" ]]; then
      all_ready=0
    fi
  done
  if ((all_ready)); then
    break
  fi
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

failed=0
for index in "${!urls[@]}"; do
  printf '%s（%s）：HTTP %s\n' "${names[$index]}" "${urls[$index]}" "${http_codes[$index]}"
  if [[ "${http_codes[$index]}" != "200" ]]; then
    failed=1
  fi
done

if ((failed)); then
  printf '部分服务未在 120 秒内就绪，请查看日志：%s\n' "$LOG_FILE" >&2
  exit 1
fi
printf 'PilotDeck 三个入口均已就绪。\n'
