#!/usr/bin/env bash
# Copies this package, as committed at HEAD, to the preview repo and pushes it to main.
# Usage: scripts/publish-preview.sh [--dry-run]
set -euo pipefail

repo="${PI_PREVIEW_REPO:-git@github.com:humanlayer/humanlayer-pi.git}"
pkg="$(cd "$(dirname "$0")/.." && pwd)"
root="$(git -C "$pkg" rev-parse --show-toplevel)"
prefix="$(git -C "$pkg" rev-parse --show-prefix)"
sha="$(git -C "$root" rev-parse --short HEAD)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

if [ -n "$(git -C "$pkg" status --porcelain -- .)" ]; then
	echo "note: uncommitted changes in $prefix are not published" >&2
fi

git clone -q "$repo" "$out"
git -C "$out" rm -rq --ignore-unmatch .
git -C "$root" archive "HEAD:${prefix%/}" | tar -x -C "$out"

# The skills ship in skills/, copied from the plugin sources as committed (the paths in
# src/skills.ts). -L copies the files that their links to other plugins point at.
src="$(mktemp -d)"
trap 'rm -rf "$out" "$src"' EXIT
git -C "$root" archive HEAD apps/riptide-rpi-claude-plugin/skills apps/riptide-humanlayer-claude-plugin/skills | tar -x -C "$src"
mkdir -p "$out/skills"
cp -RL "$src/apps/riptide-rpi-claude-plugin/skills" "$out/skills/rpi"
cp -RL "$src/apps/riptide-humanlayer-claude-plugin/skills" "$out/skills/humanlayer"

# The monorepo's `catalog:` versions mean nothing outside it; npm needs real ones.
node -e '
const fs = require("node:fs")
const [file, rootFile] = process.argv.slice(1)
const rootPkg = JSON.parse(fs.readFileSync(rootFile, "utf8"))
const catalog = rootPkg.catalog ?? rootPkg.workspaces?.catalog ?? {}
const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
	for (const name of Object.keys(deps ?? {})) {
		if (deps[name] !== "catalog:") continue
		if (!catalog[name]) throw new Error(`no catalog version for ${name}`)
		deps[name] = catalog[name]
	}
}
fs.writeFileSync(file, JSON.stringify(pkg, null, "\t") + "\n")
' "$out/package.json" "$root/package.json"

# -f: everything here came from git, and a global ignore (such as `rpi/`) must not drop any of it.
git -C "$out" add -A -f
if git -C "$out" diff --cached --quiet; then
	echo "preview repo already matches $sha"
	exit 0
fi
git -C "$out" commit -qm "Sync from humanlayer/synclayer@$sha"
git -C "$out" --no-pager show --stat --format='%s' HEAD
if [ "${1:-}" = "--dry-run" ]; then
	echo "dry run: not pushed"
	exit 0
fi
git -C "$out" push -q origin HEAD:main
echo "pushed $sha to $repo"
