#!/bin/sh
# 经 gate 中继推送（proxy.344977.xyz 是"路径式"中继：https://gate/{完整URL}）
#
#   ./scripts/push-gate.sh               # 推 main
#   ./scripts/push-gate.sh --direct      # 改走 GitHub 直连
#
# 令牌来源优先级：$GITHUB_TOKEN > .git/gate-token（本地文件，已被 .gitignore 之外的 .git/ 天然排除）
set -eu

cd "$(dirname "$0")/.." || exit 1

REPO="yingo-server/MyYesterday"
GATE="https://proxy.344977.xyz"
TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .git/gate-token ]; then
  TOKEN=$(cat .git/gate-token)
fi
if [ -z "$TOKEN" ]; then
  echo "缺少令牌：export GITHUB_TOKEN=... 或写入 .git/gate-token" >&2
  exit 1
fi

if [ "${1:-}" = "--direct" ]; then
  URL="https://github.com/$REPO.git"
else
  URL="$GATE/https://github.com/$REPO.git"
fi

AUTH_B64=$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')

echo "→ $URL"
exec git -c credential.helper= \
  -c "http.extraHeader=AUTHORIZATION: basic $AUTH_B64" \
  -c http.followRedirects=true \
  push "$URL" "${2:-main}"
