#!/usr/bin/env sh
# Keep the package-lock-derived Nix fixed-output hash honest before a full build.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

expected=$(sed -n 's/^[[:space:]]*npmDepsHash = "\([^"]*\)";$/\1/p' flake.nix)
actual=$(nix run nixpkgs#prefetch-npm-deps -- package-lock.json)

if [ "$actual" = "$expected" ]; then
  exit 0
fi

printf '%s\n' "npmDepsHash in flake.nix is stale." >&2
printf '%s\n' "Run: npm run nix:refresh-deps" >&2
printf '%s\n' "Expected: $actual" >&2
exit 1
