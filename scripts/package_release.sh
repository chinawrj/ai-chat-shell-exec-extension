#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION_INPUT="${1:-}"

cd "$ROOT_DIR"

if [[ "${ALLOW_DIRTY:-0}" != "1" ]] && ! git diff --quiet --ignore-submodules --; then
  echo "Worktree has unstaged changes. Commit or set ALLOW_DIRTY=1 for a local test package." >&2
  exit 1
fi

if [[ "${ALLOW_DIRTY:-0}" != "1" ]] && ! git diff --cached --quiet --ignore-submodules --; then
  echo "Worktree has staged changes. Commit or set ALLOW_DIRTY=1 for a local test package." >&2
  exit 1
fi

if [[ "${ALLOW_DIRTY:-0}" != "1" ]] && [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Worktree has untracked files. Commit, remove, or set ALLOW_DIRTY=1 for a local test package." >&2
  git ls-files --others --exclude-standard >&2
  exit 1
fi

if [[ -n "$VERSION_INPUT" ]]; then
  VERSION="${VERSION_INPUT#v}"
else
  VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("extension/manifest.json", "utf8")).version)')"
fi

TAG="v$VERSION"
PACKAGE_BASENAME="ai-chat-shell-exec-extension-$TAG"
OUT_DIR="$ROOT_DIR/dist/release/$TAG"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

SOURCE_ZIP="$OUT_DIR/$PACKAGE_BASENAME-source.zip"
EXTENSION_ZIP="$OUT_DIR/$PACKAGE_BASENAME-chrome-extension.zip"

git archive \
  --format=zip \
  --prefix="$PACKAGE_BASENAME/" \
  --output="$SOURCE_ZIP" \
  HEAD

(
  cd "$ROOT_DIR/extension"
  zip -qr "$EXTENSION_ZIP" manifest.json popup.html src
)

(
  cd "$OUT_DIR"
  shasum -a 256 ./*.zip > SHA256SUMS.txt
)

echo "Release assets written to $OUT_DIR"
echo "$SOURCE_ZIP"
echo "$EXTENSION_ZIP"
echo "$OUT_DIR/SHA256SUMS.txt"
