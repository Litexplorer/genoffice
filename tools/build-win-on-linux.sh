#!/usr/bin/env bash
#
# Build the Windows installer on Linux.
#
# electron-builder can produce the NSIS installer on Linux, but only when the
# Windows-only native pieces already exist: the x64 sidecar, the clipboard
# helper and an rcedit-capable Wine. This script does exactly what the release
# pipeline does for Windows, in dependency order, and stops with an actionable
# message instead of an electron-builder "file source doesn't exist" note when a
# prerequisite is missing (electron-builder exits 0 on a missing extraResources
# source, which would silently ship a broken Sheets).
#
#   ./tools/build-win-on-linux.sh                 # full build
#   ./tools/build-win-on-linux.sh --skip-native   # reuse built sidecars
#   ./tools/build-win-on-linux.sh --skip-renderers# reuse apps/*/out
#
# Output: apps/shell/release/GenOffice Setup <version>.exe (+ .blockmap)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
SKIP_NATIVE=0
SKIP_RENDERERS=0
for arg in "$@"; do
  case "$arg" in
    --skip-native) SKIP_NATIVE=1 ;;
    --skip-renderers) SKIP_RENDERERS=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'error: %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$2"; }

WIN_TARGET=x86_64-pc-windows-gnu
SIDECAR=apps/sheets/native/xlsx-engine/target/$WIN_TARGET/release/xlsx-sidecar.exe
CLIPBOARD=apps/sheets/native/win-clipboard-helper/target/$WIN_TARGET/release/win-clipboard-helper.exe

step "checking the toolchain"
need node "node is required (>= 22.12, see package.json engines)"
need npm "npm is required"
need cargo "cargo is required: the xlsx sidecar is a Rust binary"
need rustup "rustup is required to add the $WIN_TARGET target"
need x86_64-w64-mingw32-gcc \
  "install the mingw-w64 cross compiler: sudo apt-get install mingw-w64"
need wine \
  "install wine: electron-builder stamps the exe with rcedit through it (sudo apt-get install wine64)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || fail "node $(node -v) is too old, package.json engines asks for >= 22.12"
rustup target list --installed | grep -qx "$WIN_TARGET" \
  || fail "add the cross target first: rustup target add $WIN_TARGET"
wine --version >/dev/null 2>&1 || fail "wine is installed but not runnable"

# cargo walks up looking for a workspace: an unrelated Cargo.toml above this
# checkout makes every package here "believe it's in a workspace when it's not".
ancestor=$(cd "$ROOT" && while [ "$PWD" != "/" ]; do cd ..; [ -f Cargo.toml ] && { echo "$PWD/Cargo.toml"; break; }; done)
if [ -n "$ancestor" ]; then
  printf 'warning: %s sits above this checkout. cargo will refuse to build the\n' "$ancestor" >&2
  printf '         sidecars ("believes it is in a workspace when it is not"). Either\n' >&2
  printf '         add this repo to that workspace exclude list, build from a path\n' >&2
  printf '         with no Cargo.toml above it, or rerun with --skip-native using\n' >&2
  printf '         sidecars built elsewhere.\n' >&2
fi

step "installing dependencies"
if [ ! -d node_modules ]; then npm ci; else echo "node_modules present, skipping npm ci"; fi

if [ "$SKIP_NATIVE" = 0 ]; then
  step "cross-building the Windows sidecars"
  cargo build --release --target "$WIN_TARGET" \
    --manifest-path apps/sheets/native/xlsx-engine/Cargo.toml \
    --config apps/sheets/native/xlsx-engine/.cargo/config.toml
  cargo build --release --target "$WIN_TARGET" \
    --manifest-path apps/sheets/native/win-clipboard-helper/Cargo.toml \
    --config apps/sheets/native/win-clipboard-helper/.cargo/config.toml
fi
for f in "$SIDECAR" "$CLIPBOARD"; do
  [ -f "$f" ] || fail "missing $f — rerun without --skip-native"
done
file "$CLIPBOARD" | grep -q 'PE32+' || fail "$CLIPBOARD is not a Windows executable"

if [ "$SKIP_RENDERERS" = 0 ]; then
  step "building the renderers and the bundled CLI"
  npm run notices
  npm run build:all
fi
for d in docs sheets slides pdf markdown html epub; do
  [ -f "apps/$d/out/renderer/index.html" ] || fail "apps/$d/out is missing — rerun without --skip-renderers"
done
[ -f packages/cli/dist/genoffice.cjs ] || fail "packages/cli/dist is missing — rerun without --skip-renderers"

step "packaging with electron-builder (NSIS, wine)"
npm run dist:win -w @genoffice/shell

ARTIFACT=$(ls -t apps/shell/release/*.exe | grep -v __uninstaller | head -1)
[ -n "$ARTIFACT" ] || fail "electron-builder produced no installer"
step "done"
printf 'artifact: %s\n' "$ROOT/$ARTIFACT"
printf 'size:     %s bytes\n' "$(stat -c %s "$ARTIFACT")"
printf 'sha256:   %s\n' "$(sha256sum "$ARTIFACT" | cut -d' ' -f1)"
