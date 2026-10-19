#!/usr/bin/env bash
# ==============================================================================
# Principal CLI - Universal Installer (Curl, Self-Extracting, or Local)
# Installs Principal for local AI agent orchestration and quota sharing.
# ==============================================================================
set -euo pipefail

# Text Formatting
if [ -t 1 ]; then
  BOLD="\033[1m"
  GREEN="\033[0;32m"
  CYAN="\033[0;36m"
  YELLOW="\033[0;33m"
  RED="\033[0;31m"
  RESET="\033[0m"
else
  BOLD=""
  GREEN=""
  CYAN=""
  YELLOW=""
  RED=""
  RESET=""
fi

# Detect OS and Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "${OS}" in
  linux*) PLATFORM="linux" ;;
  darwin*) PLATFORM="darwin" ;;
  *) echo -e "${RED}❌ Unsupported OS: ${OS}${RESET}" >&2; exit 1 ;;
esac

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64) ARCH_NAME="x64" ;;
  aarch64|arm64) ARCH_NAME="arm64" ;;
  *) echo -e "${RED}❌ Unsupported architecture: ${ARCH}${RESET}" >&2; exit 1 ;;
esac

BUNDLE_NAME="principal-${PLATFORM}-${ARCH_NAME}.tar.gz"

if [ -z "${PREFIX:-}" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    PREFIX="/usr/local"
  else
    PREFIX="${HOME}/.local"
  fi
fi
BIN_DIR="${PREFIX}/bin"
DATA_DIR="${PREFIX}/share/principal"
MODE="install"
CUSTOM_URL="${PRINCIPAL_URL:-}"
GITHUB_REPO="${PRINCIPAL_REPO:-dyfintie/principal}"
DEFAULT_BASE_URL=""

show_help() {
  cat << EOF
Principal CLI Universal Installer

Usage:
  ./install.sh [options]
  curl -fsSL <url>/install.sh | bash [options]

Options:
  --dev, --link       Link current repository in-place (ideal for development)
  --uninstall         Remove Principal from ~/.local/share/principal and ~/.local/bin
  --prefix <path>     Custom installation prefix (default: ~/.local)
  --url <url>         Custom download URL for the distribution bundle
  --repo <owner/repo> Custom GitHub repository for releases (default: dyfintie/principal)
  -h, --help          Show this help message

Environment Variables:
  PRINCIPAL_URL       Custom URL to download the pre-compiled bundle from
  PRINCIPAL_REPO      GitHub repository (owner/repo) to download releases from
  PREFIX              Target prefix directory (default: ~/.local)
EOF
}

# Parse options
while [ $# -gt 0 ]; do
  case "$1" in
    --dev|--link)
      MODE="dev"
      shift
      ;;
    --uninstall)
      MODE="uninstall"
      shift
      ;;
    --prefix)
      PREFIX="$2"
      BIN_DIR="${PREFIX}/bin"
      DATA_DIR="${PREFIX}/share/principal"
      shift 2
      ;;
    --url)
      CUSTOM_URL="$2"
      shift 2
      ;;
    --repo)
      GITHUB_REPO="$2"
      shift 2
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${RESET}" >&2
      show_help
      exit 1
      ;;
  esac
done

echo -e "${BOLD}${CYAN}================================================================${RESET}"
echo -e "${BOLD}${CYAN}             Principal CLI - Universal Installer               ${RESET}"
echo -e "${BOLD}${CYAN}      Local AI Coding Agent Orchestration & Quota Sharing       ${RESET}"
echo -e "${BOLD}${CYAN}================================================================${RESET}"

# ------------------------------------------------------------------------------
# Handle Uninstallation
# ------------------------------------------------------------------------------
if [ "${MODE}" = "uninstall" ]; then
  echo -e "\n${YELLOW}Uninstalling Principal...${RESET}"
  rm -f "${BIN_DIR}/principal" "${BIN_DIR}/principal-mcp"
  if [ -d "${DATA_DIR}" ]; then
    rm -rf "${DATA_DIR}"
  fi
  echo -e "${GREEN}✓ Principal executables and shared files removed successfully.${RESET}"
  echo -e "Note: User configuration in ~/.local/state/principal and ~/.config/principal was preserved."
  exit 0
fi

# ------------------------------------------------------------------------------
# 1. Environment & Node.js Verification
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[1/5] Checking environment & Node.js...${RESET}"

NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  for candidate in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
    if [ -x "${candidate}" ]; then
      NODE_BIN="${candidate}"
      break
    fi
  done
fi

if [ -z "${NODE_BIN}" ]; then
  echo -e "${RED}❌ Error: Node.js runtime not found.${RESET}"
  echo -e "Principal requires Node.js v24+ (Node v20+ minimum) to run."
  echo ""
  echo "To install Node.js in seconds, run:"
  echo "  • NVM (recommended):       curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 24"
  echo "  • On Arch Linux:           sudo pacman -S nodejs npm"
  echo "  • On Ubuntu / Debian:      curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs"
  echo "  • On Fedora:               sudo dnf install -y nodejs"
  echo "  • On macOS (Homebrew):     brew install node@24"
  echo ""
  echo "Then run this installer again."
  exit 1
fi

NODE_VERSION="$("${NODE_BIN}" -v)"
NODE_MAJOR="$("${NODE_BIN}" -v | sed 's/v//' | cut -d. -f1)"

echo -e "  Found Node.js: ${GREEN}${NODE_VERSION}${RESET} (${NODE_BIN})"

if [ "${NODE_MAJOR}" -lt 24 ]; then
  echo -e "${RED}❌ Error: Principal requires Node.js v24+ (found: ${NODE_VERSION}).${RESET}"
  echo -e "The pre-compiled native SQLite runtime and ES features require Node.js 24+."
  echo ""
  echo "How to get Node.js 24+:"
  echo "  • In Docker:               Use image 'node:24-bookworm' or 'node:24-slim'"
  echo "  • NVM (Node Version Mgr):  nvm install 24 && nvm use 24"
  echo "  • Debian / Ubuntu:         curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs"
  echo "  • Arch Linux:              sudo pacman -S nodejs npm"
  echo "  • macOS (Homebrew):        brew install node@24"
  echo ""
  echo "After switching to Node 24+, run this installer again."
  exit 1
fi

# ------------------------------------------------------------------------------
# 2. Determine Installation Source
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[2/5] Preparing Principal distribution...${RESET}"

SCRIPT_FILE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR=""
if [ -f "${SCRIPT_FILE}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_FILE}")" 2>/dev/null && pwd || echo "")"
fi

TMP_DIR=""
cleanup_tmp() {
  if [ -n "${TMP_DIR}" ] && [ -d "${TMP_DIR}" ]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup_tmp EXIT

# Check if script contains embedded payload (self-extracting archive)
if [ -f "${SCRIPT_FILE}" ] && grep -a -q "^__ARCHIVE_MARKER__$" "${SCRIPT_FILE}" 2>/dev/null; then
  echo -e "  ${GREEN}✓ Self-extracting archive detected. Unpacking embedded files...${RESET}"
  mkdir -p "${DATA_DIR}"
  ARCHIVE_LINE=$(awk '/^__ARCHIVE_MARKER__$/ {print NR + 1; exit 0; }' "${SCRIPT_FILE}")
  tail -n +"${ARCHIVE_LINE}" "${SCRIPT_FILE}" | tar -xz -C "${DATA_DIR}"
  # If the tarball wrapped files in a 'principal' folder, flatten it
  if [ -d "${DATA_DIR}/principal" ]; then
    cp -r "${DATA_DIR}/principal"/* "${DATA_DIR}/"
    rm -rf "${DATA_DIR}/principal"
  fi
  TARGET_DIR="${DATA_DIR}"

# Check if pre-compiled files exist next to the script
elif [ -n "${SCRIPT_DIR}" ] && [ -d "${SCRIPT_DIR}/dist" ] && [ -d "${SCRIPT_DIR}/node_modules" ]; then
  echo -e "  ${GREEN}✓ Local pre-compiled package detected. Zero build required!${RESET}"
  if [ "${MODE}" = "dev" ]; then
    TARGET_DIR="${SCRIPT_DIR}"
  else
    TARGET_DIR="${DATA_DIR}"
    if [ "${SCRIPT_DIR}" != "${TARGET_DIR}" ]; then
      mkdir -p "${DATA_DIR}"
      cp -r "${SCRIPT_DIR}/bin" "${DATA_DIR}/"
      cp -r "${SCRIPT_DIR}/dist" "${DATA_DIR}/"
      cp -r "${SCRIPT_DIR}/runtime" "${DATA_DIR}/"
      cp -r "${SCRIPT_DIR}/node_modules" "${DATA_DIR}/"
      cp "${SCRIPT_DIR}/package.json" "${DATA_DIR}/"
      [ -f "${SCRIPT_DIR}/README.md" ] && cp "${SCRIPT_DIR}/README.md" "${DATA_DIR}/"
      [ -d "${SCRIPT_DIR}/docs" ] && cp -r "${SCRIPT_DIR}/docs" "${DATA_DIR}/"
    fi
  fi

# Check if git source repository exists next to the script
elif [ -n "${SCRIPT_DIR}" ] && [ -f "${SCRIPT_DIR}/package.json" ] && [ -d "${SCRIPT_DIR}/src" ]; then
  echo -e "  Local source checkout detected. Building Principal..."
  if ! command -v npm >/dev/null 2>&1; then
    echo -e "${RED}❌ Error: npm is required to build from source.${RESET}"
    exit 1
  fi
  cd "${SCRIPT_DIR}"
  if [ ! -d "node_modules" ]; then
    echo "  Installing dependencies..."
    npm install
  fi
  echo "  Compiling TypeScript..."
  npm run build
  if [ "${MODE}" = "dev" ]; then
    TARGET_DIR="${SCRIPT_DIR}"
  else
    TARGET_DIR="${DATA_DIR}"
    mkdir -p "${DATA_DIR}"
    cp -r "${SCRIPT_DIR}/bin" "${DATA_DIR}/"
    cp -r "${SCRIPT_DIR}/dist" "${DATA_DIR}/"
    cp -r "${SCRIPT_DIR}/runtime" "${DATA_DIR}/"
    cp -r "${SCRIPT_DIR}/node_modules" "${DATA_DIR}/"
    cp "${SCRIPT_DIR}/package.json" "${DATA_DIR}/"
    [ -f "${SCRIPT_DIR}/README.md" ] && cp "${SCRIPT_DIR}/README.md" "${DATA_DIR}/"
    [ -d "${SCRIPT_DIR}/docs" ] && cp -r "${SCRIPT_DIR}/docs" "${DATA_DIR}/"
  fi

# Otherwise, running remotely (e.g. curl -fsSL ... | bash) -> Download pre-compiled bundle
else
  if [ -n "${CUSTOM_URL}" ]; then
    DOWNLOAD_URL="${CUSTOM_URL}"
  elif [ -n "${DEFAULT_BASE_URL}" ]; then
    DOWNLOAD_URL="${DEFAULT_BASE_URL}/${BUNDLE_NAME}"
  else
    DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/${BUNDLE_NAME}"
  fi
  echo -e "  Downloading Principal (${PLATFORM}-${ARCH_NAME}) from:"
  echo -e "    ${CYAN}${DOWNLOAD_URL}${RESET}"

  TMP_DIR="$(mktemp -d -t principal-install-XXXXXX)"
  TMP_TAR="${TMP_DIR}/${BUNDLE_NAME}"

  if ! curl -fsSL "${DOWNLOAD_URL}" -o "${TMP_TAR}"; then
    echo -e "  ${YELLOW}! Pre-compiled release bundle not yet published at:${RESET}"
    echo -e "    ${DOWNLOAD_URL}"
    echo -e "  ${CYAN}• Automatically falling back to repository source checkout...${RESET}"

    SRC_TAR="${TMP_DIR}/source.tar.gz"
    SOURCE_URL="https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz"
    if curl -fsSL "${SOURCE_URL}" -o "${SRC_TAR}"; then
      tar -xzf "${SRC_TAR}" -C "${TMP_DIR}"
      EXTRACTED_SRC="$(find "${TMP_DIR}" -maxdepth 1 -type d -name "*principal*" | head -n 1)"
      if [ -n "${EXTRACTED_SRC}" ] && [ -f "${EXTRACTED_SRC}/package.json" ]; then
        cd "${EXTRACTED_SRC}"
        echo "  Installing dependencies and compiling runtime..."
        npm install
        npm run build
        mkdir -p "${DATA_DIR}"
        cp -r bin dist runtime node_modules package.json README.md "${DATA_DIR}/"
        [ -d docs ] && cp -r docs "${DATA_DIR}/"
        TARGET_DIR="${DATA_DIR}"
      else
        echo -e "${RED}❌ Failed to extract source archive.${RESET}" >&2
        exit 1
      fi
    else
      echo -e "\n${RED}❌ Error: Failed to download release bundle or source.${RESET}" >&2
      echo -e "Please ensure the repository https://github.com/${GITHUB_REPO} exists." >&2
      exit 1
    fi
  else
    echo -e "  ${GREEN}✓ Download complete. Deploying to ${DATA_DIR}...${RESET}"
    mkdir -p "${DATA_DIR}"
    tar -xzf "${TMP_TAR}" -C "${TMP_DIR}"

    EXTRACTED_SRC="${TMP_DIR}"
    if [ -d "${TMP_DIR}/principal" ]; then
      EXTRACTED_SRC="${TMP_DIR}/principal"
    fi

    cp -r "${EXTRACTED_SRC}"/* "${DATA_DIR}/"
    TARGET_DIR="${DATA_DIR}"
  fi
fi

# ------------------------------------------------------------------------------
# 3. Executable Symlinks in ~/.local/bin
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[3/5] Configuring executables...${RESET}"

mkdir -p "${BIN_DIR}"
rm -f "${BIN_DIR}/principal" "${BIN_DIR}/principal-mcp"

ln -sf "${TARGET_DIR}/bin/principal.mjs" "${BIN_DIR}/principal"
ln -sf "${TARGET_DIR}/bin/principal-mcp.mjs" "${BIN_DIR}/principal-mcp"
chmod +x "${BIN_DIR}/principal" "${BIN_DIR}/principal-mcp"

echo -e "  ${GREEN}✓ Created symlink: ${BIN_DIR}/principal${RESET}"
echo -e "  ${GREEN}✓ Created symlink: ${BIN_DIR}/principal-mcp${RESET}"

# Terminate any running background daemon so new code takes effect immediately
pkill -f "daemon.js" 2>/dev/null || true
rm -f "${HOME}/.local/state/principal/management/manager.sock" 2>/dev/null || true

# ------------------------------------------------------------------------------
# 4. Shell PATH Verification & Auto-Configuration
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[4/5] Checking shell PATH...${RESET}"

IN_PATH=0
case ":${PATH}:" in
  *":${BIN_DIR}:"*) IN_PATH=1 ;;
  *) IN_PATH=0 ;;
esac

if [ "${IN_PATH}" -eq 1 ]; then
  echo -e "  ${GREEN}✓ ${BIN_DIR} is already in your PATH!${RESET}"
else
  echo -e "  ${YELLOW}! ${BIN_DIR} is not in your current PATH.${RESET}"
  
  CURRENT_SHELL="$(basename "${SHELL:-bash}")"
  CONFIGURED_FILE=""

  if [ "${CURRENT_SHELL}" = "fish" ] || [ -n "${FISH_VERSION:-}" ]; then
    if command -v fish >/dev/null 2>&1; then
      fish -c "fish_add_path -U '${BIN_DIR}'" 2>/dev/null || true
      CONFIGURED_FILE="Fish universal path (fish_add_path)"
    fi
  elif [ "${CURRENT_SHELL}" = "zsh" ] || [ -f "${HOME}/.zshrc" ]; then
    CONFIG_FILE="${HOME}/.zshrc"
    if ! grep -q "${BIN_DIR}" "${CONFIG_FILE}" 2>/dev/null; then
      echo "" >> "${CONFIG_FILE}"
      echo "# Added by Principal installer" >> "${CONFIG_FILE}"
      echo "export PATH=\"${BIN_DIR}:\$PATH\"" >> "${CONFIG_FILE}"
      CONFIGURED_FILE="${CONFIG_FILE}"
    fi
  else
    CONFIG_FILE="${HOME}/.bashrc"
    [ -f "${HOME}/.bash_profile" ] && [ ! -f "${HOME}/.bashrc" ] && CONFIG_FILE="${HOME}/.bash_profile"
    if ! grep -q "${BIN_DIR}" "${CONFIG_FILE}" 2>/dev/null; then
      echo "" >> "${CONFIG_FILE}"
      echo "# Added by Principal installer" >> "${CONFIG_FILE}"
      echo "export PATH=\"${BIN_DIR}:\$PATH\"" >> "${CONFIG_FILE}"
      CONFIGURED_FILE="${CONFIG_FILE}"
    fi
  fi

  if [ -n "${CONFIGURED_FILE}" ]; then
    echo -e "  ${GREEN}✓ Automatically added ${BIN_DIR} to ${CONFIGURED_FILE}${RESET}"
    echo -e "  ${CYAN}(Restart your terminal or run: export PATH=\"${BIN_DIR}:\$PATH\")${RESET}"
  else
    echo -e "  To run 'principal' directly, add this to your shell profile:"
    echo -e "    ${BOLD}export PATH=\"${BIN_DIR}:\$PATH\"${RESET}"
  fi
fi

# ------------------------------------------------------------------------------
# 5. Sanity & Health Check
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[5/5] Running system verification...${RESET}"
"${BIN_DIR}/principal" doctor || {
  echo -e "  ${YELLOW}Notice: Verification completed with environment warnings.${RESET}"
}

echo ""
echo -e "${BOLD}${GREEN}================================================================${RESET}"
echo -e "${BOLD}${GREEN}           🎉 Principal Setup Completed Successfully!           ${RESET}"
echo -e "${BOLD}${GREEN}================================================================${RESET}"
echo ""
echo -e "Quick Start Guide:"
echo -e "  ${BOLD}principal${RESET}                          Open interactive TUI dashboard"
echo -e "  ${BOLD}principal launch agy${RESET}               Launch Antigravity assistant"
echo -e "  ${BOLD}principal launch cdx${RESET}               Launch OpenAI Codex assistant"
echo -e "  ${BOLD}principal handoff import <code>${RESET}    Import shared account quota from a friend"
echo -e "  ${BOLD}principal doctor${RESET}                   Check system status & detected AI tools"
echo -e "  ${BOLD}principal --help${RESET}                   View CLI overview"
echo ""
echo -e "Inside the Principal TUI:"
echo -e "  ${CYAN}/launch (/l) <tool>${RESET}               Launch an AI agent session"
echo -e "  ${CYAN}/swap   (/sw) <tool>${RESET}               Hot swap active profile"
echo -e "  ${CYAN}/usage  (/u)${RESET}                       Inspect token and weekly quota usage"
echo -e "  ${CYAN}/help   (/h)${RESET}                       Show interactive command reference"
echo -e "${BOLD}${GREEN}================================================================${RESET}"
exit 0
