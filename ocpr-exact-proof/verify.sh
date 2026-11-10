set -euo pipefail
mkdir -p "$OCPR_EVIDENCE_DIR"
file=server/bot-box/ask-socket.linux.test.ts
restore() { git show "HEAD:$file" > "$file"; }
trap restore EXIT
git show "HEAD^:$file" > "$file"
set +e
pnpm exec vitest run "$file" > "$OCPR_EVIDENCE_DIR/before.log" 2>&1
before=$?
set -e
cat "$OCPR_EVIDENCE_DIR/before.log"
test "$before" = 1
rg "Can't find source path .*workspaces/bot-a: No such file or directory" "$OCPR_EVIDENCE_DIR/before.log"
restore
pnpm exec vitest run "$file" > "$OCPR_EVIDENCE_DIR/after.log" 2>&1 || { cat "$OCPR_EVIDENCE_DIR/after.log"; exit 1; }
cat "$OCPR_EVIDENCE_DIR/after.log"
grep -E 'Tests +1 passed' "$OCPR_EVIDENCE_DIR/after.log"
test -z "$(git status --porcelain)"
