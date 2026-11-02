#!/usr/bin/env sh
# Refresh the Nix fixed-output hash after package-lock.json changes.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

hash=$(nix run nixpkgs#prefetch-npm-deps -- package-lock.json)
NPM_DEPS_HASH="$hash" perl -0pi -e \
  's/(npmDepsHash = ")[^"]+(";)/$1 . $ENV{NPM_DEPS_HASH} . $2/ge' flake.nix

printf '%s\n' "Updated npmDepsHash to $hash"
