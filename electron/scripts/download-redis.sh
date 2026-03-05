#!/usr/bin/env bash
#
# Build redis-server from source for the current platform.
# Outputs to resources/redis-standalone/bin/redis-server for bundling as extraResources.
#
# Usage: ./scripts/download-redis.sh
#
set -euo pipefail

REDIS_VERSION="7.4.2"
BASE_URL="https://github.com/redis/redis/archive/refs/tags"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${PROJECT_DIR}/resources/redis-standalone"

# Determine platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Darwin|Linux) ;;
  *)
    echo "Unsupported OS: ${OS} (Redis build supports macOS and Linux only)"
    exit 1
    ;;
esac

# Check if already built
MARKER="${OUTPUT_DIR}/.redis-version"
if [[ -f "${MARKER}" ]] && [[ "$(cat "${MARKER}")" == "${REDIS_VERSION}-${OS}-${ARCH}" ]]; then
  echo "Redis ${REDIS_VERSION} (${OS}/${ARCH}) already built"
  exit 0
fi

echo "Building Redis ${REDIS_VERSION} for ${OS}/${ARCH}..."

# Clean previous build
rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}/bin"

# Download source
TMPDIR="$(mktemp -d)"
trap "rm -rf ${TMPDIR}" EXIT

TARBALL="${TMPDIR}/redis-${REDIS_VERSION}.tar.gz"
URL="${BASE_URL}/${REDIS_VERSION}.tar.gz"

echo "  Downloading: ${URL}"
curl -fSL --progress-bar "${URL}" -o "${TARBALL}"

echo "  Extracting..."
tar -xzf "${TARBALL}" -C "${TMPDIR}"

SRC_DIR="${TMPDIR}/redis-${REDIS_VERSION}"

# Build redis-server only (skip redis-cli, redis-benchmark, etc.)
echo "  Compiling redis-server..."
NPROC=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)

# Use jemalloc on Linux, libc on macOS (simpler, no cross-compile issues)
MALLOC_FLAG=""
if [[ "${OS}" == "Darwin" ]]; then
  MALLOC_FLAG="MALLOC=libc"
fi

make -C "${SRC_DIR}" -j"${NPROC}" redis-server ${MALLOC_FLAG} 2>&1 | tail -5

# Copy binary
cp "${SRC_DIR}/src/redis-server" "${OUTPUT_DIR}/bin/redis-server"
chmod +x "${OUTPUT_DIR}/bin/redis-server"

# Write version marker
echo "${REDIS_VERSION}-${OS}-${ARCH}" > "${MARKER}"

# Verify
if [[ ! -x "${OUTPUT_DIR}/bin/redis-server" ]]; then
  echo "ERROR: redis-server binary not found at ${OUTPUT_DIR}/bin/redis-server"
  exit 1
fi

VERSION_OUTPUT="$("${OUTPUT_DIR}/bin/redis-server" --version)"
echo "Successfully built: ${VERSION_OUTPUT}"
echo "Location: ${OUTPUT_DIR}/bin/redis-server"

# Print size
du -sh "${OUTPUT_DIR}/bin/redis-server" | awk '{print "Size: " $1}'
