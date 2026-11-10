set -euo pipefail
mkdir -p "$OCPR_EVIDENCE_DIR"
file=server/box-attachments.linux.test.ts
ask=server/bot-box/ask-socket.linux.test.ts
restore() { git show "HEAD:$file" > "$file"; }
trap restore EXIT
git show "HEAD^:$file" > "$file"
set +e
pnpm exec vitest run "$file" > "$OCPR_EVIDENCE_DIR/before.log" 2>&1
before=$?
set -e
cat "$OCPR_EVIDENCE_DIR/before.log"
test "$before" = 1
grep -F "expected null to be 'quarterly notes" "$OCPR_EVIDENCE_DIR/before.log"
restore
pnpm exec vitest run "$file" "$ask" > "$OCPR_EVIDENCE_DIR/after.log" 2>&1 || { cat "$OCPR_EVIDENCE_DIR/after.log"; exit 1; }
cat "$OCPR_EVIDENCE_DIR/after.log"
grep -E 'Tests +2 passed' "$OCPR_EVIDENCE_DIR/after.log"
test -z "$(git status --porcelain)"
