#!/usr/bin/env bash
# ==============================================================================
# Principal - Zero-Friction Bootstrap Installer (Scripts Shortcut)
# Delegates directly to the universal root installer.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

exec "${ROOT_DIR}/install.sh" "$@"
