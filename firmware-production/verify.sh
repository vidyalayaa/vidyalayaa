#!/usr/bin/env bash
set -euo pipefail
# Compile only. No serial port, eFuse operation, production key or network access.
root="$(cd "$(dirname "$0")/.." && pwd)"
g++ -std=c++17 -Wall -Wextra -Werror "$root/firmware-production/core/queue.cpp" "$root/firmware-production/tests/queue_test.cpp" -o /tmp/vidyalayaa-queue-test
/tmp/vidyalayaa-queue-test
work="$(mktemp -d /tmp/vidyalayaa-build.XXXXXX)"
cp -R "$root/firmware-production" "$work/firmware-production"
mkdir -p "$work/firmware/include" "$work/firmware-production/secrets"
cp "$root/firmware/include/protocol.generated.h" "$work/firmware/include/"
cd "$work/firmware-production"
# This disposable key proves compilation only; it MUST NOT be used on a reader.
espsecure.py generate_signing_key --version 2 secrets/secure_boot_signing_key.pem
idf.py build
echo 'Compile verification only: disposable signing key, not a production release.'
