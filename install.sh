#!/usr/bin/env bash
# install.sh — Install cloclo (multi-provider AI coding agent CLI)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/anthropics/cloclo/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/anthropics/cloclo/main/install.sh | bash -s -- --prefix /opt
#
# Options:
#   --prefix <dir>   Install prefix (default: /usr/local)
#   --version <ver>  Install specific version (default: latest)
#   --uninstall      Remove cloclo

set -euo pipefail

# ── Config ────────────────────────────────────────────────────

REPO="anthropics/cloclo"
BIN_NAME="cloclo"
DEFAULT_PREFIX="/usr/local"
MIN_NODE_VERSION=18

# ── Colors ────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

info()  { printf "${BLUE}▸${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET} %s\n" "$*"; }
err()   { printf "${RED}✗${RESET} %s\n" "$*" >&2; }
die()   { err "$*"; exit 1; }

# ── Parse args ────────────────────────────────────────────────

PREFIX="$DEFAULT_PREFIX"
VERSION="latest"
UNINSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)   PREFIX="$2"; shift 2 ;;
    --version)  VERSION="$2"; shift 2 ;;
    --uninstall) UNINSTALL=true; shift ;;
    *) die "Unknown option: $1" ;;
  esac
done

BIN_DIR="$PREFIX/bin"
LIB_DIR="$PREFIX/lib/cloclo"

# ── Uninstall ─────────────────────────────────────────────────

if $UNINSTALL; then
  info "Uninstalling cloclo..."
  rm -f "$BIN_DIR/$BIN_NAME" 2>/dev/null || true
  rm -rf "$LIB_DIR" 2>/dev/null || true
  ok "cloclo removed from $PREFIX"
  exit 0
fi

# ── Banner ────────────────────────────────────────────────────

printf "\n${BOLD}  cloclo installer${RESET}\n"
printf "  ${DIM}Multi-provider AI coding agent CLI${RESET}\n\n"

# ── Platform detection ────────────────────────────────────────

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin) OS_LABEL="macOS" ;;
  linux)  OS_LABEL="Linux" ;;
  *)      die "Unsupported OS: $OS (only macOS and Linux)" ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)             die "Unsupported architecture: $ARCH" ;;
esac

info "Platform: $OS_LABEL $ARCH"

# ── Check Node.js ─────────────────────────────────────────────

check_node() {
  if ! command -v node &>/dev/null; then
    return 1
  fi
  local ver
  ver="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
  if [[ "$ver" -lt "$MIN_NODE_VERSION" ]]; then
    return 1
  fi
  return 0
}

install_node() {
  warn "Node.js >= $MIN_NODE_VERSION not found"
  info "Installing Node.js..."

  if command -v brew &>/dev/null; then
    brew install node
  elif command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo dnf install -y nodejs
  else
    die "Cannot auto-install Node.js. Install Node.js >= $MIN_NODE_VERSION manually:\n  https://nodejs.org/en/download"
  fi

  check_node || die "Node.js installation failed"
}

if ! check_node; then
  install_node
fi

NODE_VERSION="$(node -v)"
ok "Node.js $NODE_VERSION"

# ── Resolve version ───────────────────────────────────────────

if [[ "$VERSION" == "latest" ]]; then
  info "Fetching latest version..."
  VERSION="$(curl -fsSL "https://registry.npmjs.org/cloclo/latest" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)"
  if [[ -z "$VERSION" ]]; then
    die "Could not determine latest version"
  fi
fi

info "Version: $VERSION"

# ── Check for compiled binary ─────────────────────────────────

BINARY_URL="https://github.com/$REPO/releases/download/v${VERSION}/cloclo-${OS}-${ARCH}"
HAS_BINARY=false

if curl -fsSL --head "$BINARY_URL" &>/dev/null 2>&1; then
  HAS_BINARY=true
fi

# ── Install ───────────────────────────────────────────────────

if $HAS_BINARY; then
  # Install compiled binary (no Node.js dependency at runtime)
  info "Downloading compiled binary..."
  TMPFILE="$(mktemp)"
  curl -fsSL -o "$TMPFILE" "$BINARY_URL"
  chmod +x "$TMPFILE"

  # Verify it runs
  if ! "$TMPFILE" --help &>/dev/null; then
    warn "Binary verification failed, falling back to npm install"
    rm -f "$TMPFILE"
    HAS_BINARY=false
  else
    sudo mkdir -p "$BIN_DIR"
    sudo mv "$TMPFILE" "$BIN_DIR/$BIN_NAME"
    ok "Installed binary to $BIN_DIR/$BIN_NAME"
  fi
fi

if ! $HAS_BINARY; then
  # Install from npm — fetch tarball, extract, link
  info "Installing from npm..."

  TMPDIR="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR"' EXIT

  # Download and extract
  curl -fsSL "https://registry.npmjs.org/cloclo/-/cloclo-${VERSION}.tgz" -o "$TMPDIR/cloclo.tgz"
  tar xzf "$TMPDIR/cloclo.tgz" -C "$TMPDIR"

  # Install to lib dir
  sudo mkdir -p "$LIB_DIR" "$BIN_DIR"
  sudo rm -rf "$LIB_DIR"/*
  sudo cp "$TMPDIR/package/claude-native.mjs" "$LIB_DIR/"
  sudo cp "$TMPDIR/package/ink-ui.mjs" "$LIB_DIR/" 2>/dev/null || true
  sudo cp "$TMPDIR/package/package.json" "$LIB_DIR/"

  # Install runtime deps (the heavy ones like xlsx, pdf-lib, etc.)
  (cd "$LIB_DIR" && sudo npm install --omit=dev --no-audit --no-fund 2>/dev/null) || true

  # Create wrapper script
  sudo tee "$BIN_DIR/$BIN_NAME" > /dev/null << 'WRAPPER'
#!/usr/bin/env bash
exec node "LIBDIR/claude-native.mjs" "$@"
WRAPPER
  sudo sed -i.bak "s|LIBDIR|$LIB_DIR|g" "$BIN_DIR/$BIN_NAME" 2>/dev/null || \
    sudo sed -i '' "s|LIBDIR|$LIB_DIR|g" "$BIN_DIR/$BIN_NAME"
  sudo rm -f "$BIN_DIR/$BIN_NAME.bak"
  sudo chmod +x "$BIN_DIR/$BIN_NAME"

  ok "Installed to $LIB_DIR"
  ok "Binary at $BIN_DIR/$BIN_NAME"
fi

# ── Verify ────────────────────────────────────────────────────

if command -v "$BIN_NAME" &>/dev/null; then
  INSTALLED_VERSION="$("$BIN_NAME" --help 2>&1 | head -1 || echo "unknown")"
  ok "cloclo is ready"
else
  # Check if BIN_DIR is in PATH
  if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    warn "$BIN_DIR is not in your PATH"
    printf "\n  Add to your shell profile:\n"
    printf "  ${DIM}export PATH=\"$BIN_DIR:\$PATH\"${RESET}\n\n"
  fi
fi

# ── Done ──────────────────────────────────────────────────────

printf "\n${GREEN}${BOLD}  Installation complete!${RESET}\n\n"
printf "  Get started:\n"
printf "    ${DIM}cloclo${RESET}                          ${DIM}# Interactive REPL${RESET}\n"
printf "    ${DIM}cloclo -p \"explain this code\"${RESET}   ${DIM}# One-shot${RESET}\n"
printf "    ${DIM}cloclo --login${RESET}                   ${DIM}# Auth with Anthropic${RESET}\n"
printf "    ${DIM}cloclo --help${RESET}                    ${DIM}# Full usage${RESET}\n\n"
