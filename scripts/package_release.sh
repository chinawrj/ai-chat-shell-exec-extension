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

MANIFEST_VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("extension/manifest.json", "utf8")).version)')"

if [[ -n "$VERSION_INPUT" ]] && [[ "${VERSION_INPUT#v}" != "$MANIFEST_VERSION" ]]; then
  echo "Requested release version ${VERSION_INPUT#v} does not match extension manifest version $MANIFEST_VERSION." >&2
  exit 1
fi

VERSION="$MANIFEST_VERSION"

TAG="v$VERSION"
PACKAGE_BASENAME="ai-chat-shell-exec-extension-$TAG"
OUT_DIR="$ROOT_DIR/dist/release/$TAG"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

SOURCE_ZIP="$OUT_DIR/$PACKAGE_BASENAME-source.zip"
EXTENSION_ZIP="$OUT_DIR/$PACKAGE_BASENAME-chrome-extension.zip"

if [[ "${ALLOW_DIRTY:-0}" == "1" ]]; then
  STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ai-chat-shell-release.XXXXXX")"
  cleanup_stage() {
    rm -rf "$STAGE_DIR"
  }
  trap cleanup_stage EXIT
  mkdir -p "$STAGE_DIR/$PACKAGE_BASENAME"
  while IFS= read -r file_path; do
    if [[ ! -e "$file_path" && ! -L "$file_path" ]]; then
      continue
    fi
    mkdir -p "$STAGE_DIR/$PACKAGE_BASENAME/$(dirname "$file_path")"
    cp -pP "$file_path" "$STAGE_DIR/$PACKAGE_BASENAME/$file_path"
  done < <(git ls-files --cached --others --exclude-standard)
  (
    cd "$STAGE_DIR"
    zip -qr "$SOURCE_ZIP" "$PACKAGE_BASENAME"
  )
else
  git archive \
    --format=zip \
    --prefix="$PACKAGE_BASENAME/" \
    --output="$SOURCE_ZIP" \
    HEAD
fi

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
