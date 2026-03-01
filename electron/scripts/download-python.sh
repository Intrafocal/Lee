#!/usr/bin/env bash
#
# Download python-build-standalone for the current platform.
# Extracts to resources/python-standalone/ for bundling as extraResources.
#
# Usage: ./scripts/download-python.sh
#
set -euo pipefail

PYTHON_VERSION="3.12.8"
RELEASE_TAG="20241219"
BASE_URL="https://github.com/indygreg/python-build-standalone/releases/download/${RELEASE_TAG}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${PROJECT_DIR}/resources/python-standalone"

# Determine platform and architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Darwin)
    case "${ARCH}" in
      arm64)  TRIPLE="aarch64-apple-darwin" ;;
      x86_64) TRIPLE="x86_64-apple-darwin" ;;
      *)      echo "Unsupported macOS architecture: ${ARCH}"; exit 1 ;;
    esac
    ;;
  Linux)
    case "${ARCH}" in
      x86_64)  TRIPLE="x86_64-unknown-linux-gnu" ;;
      aarch64) TRIPLE="aarch64-unknown-linux-gnu" ;;
      *)       echo "Unsupported Linux architecture: ${ARCH}"; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: ${OS}"
    exit 1
    ;;
esac

FILENAME="cpython-${PYTHON_VERSION}+${RELEASE_TAG}-${TRIPLE}-install_only.tar.gz"
URL="${BASE_URL}/${FILENAME}"

# Check if already downloaded and extracted
MARKER="${OUTPUT_DIR}/.python-version"
if [[ -f "${MARKER}" ]] && [[ "$(cat "${MARKER}")" == "${PYTHON_VERSION}+${RELEASE_TAG}-${TRIPLE}" ]]; then
  echo "Python ${PYTHON_VERSION} (${TRIPLE}) already downloaded"
  exit 0
fi

echo "Downloading Python ${PYTHON_VERSION} for ${TRIPLE}..."
echo "  URL: ${URL}"

# Clean previous download
rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"

# Download and extract
TMPFILE="$(mktemp)"
trap "rm -f ${TMPFILE}" EXIT

curl -fSL --progress-bar "${URL}" -o "${TMPFILE}"

echo "Extracting..."
# The tarball extracts to python/ directory
tar -xzf "${TMPFILE}" -C "${OUTPUT_DIR}" --strip-components=1

# Write version marker
echo "${PYTHON_VERSION}+${RELEASE_TAG}-${TRIPLE}" > "${MARKER}"

# Verify
PYTHON_BIN="${OUTPUT_DIR}/bin/python3"
if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "ERROR: python3 binary not found at ${PYTHON_BIN}"
  exit 1
fi

VERSION_OUTPUT="$("${PYTHON_BIN}" --version)"
echo "Successfully downloaded: ${VERSION_OUTPUT}"
echo "Location: ${OUTPUT_DIR}"

# Print size
du -sh "${OUTPUT_DIR}" | awk '{print "Size: " $1}'
