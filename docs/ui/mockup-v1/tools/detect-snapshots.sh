#!/bin/sh
# Runs the impeccable design detector over the snapshots made by snapshots.mjs and prints a summary.
# Needs: IMPECCABLE (path to the impeccable launcher or binary) and IMPECCABLE_BROWSER (a Chromium executable or wrapper).
# The snapshots are served on 127.0.0.1:4175 only for the run. Full JSON: /tmp/snap/detect.json
set -eu
SNAP=${SNAP_DIR:-/tmp/snap}
: "${IMPECCABLE:?set IMPECCABLE to the impeccable launcher}"
python3 -m http.server 4175 --bind 127.0.0.1 --directory "$SNAP" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1
URLS=$(sed 's#^#http://127.0.0.1:4175/#' "$SNAP/index.txt")
# shellcheck disable=SC2086
"$IMPECCABLE" detect --json $URLS > "$SNAP/detect.json" 2> "$SNAP/detect.err" || true
python3 - "$SNAP/detect.json" <<'PY'
import json, sys, collections
d = json.load(open(sys.argv[1]))
print(f'findings: {len(d)}')
by_rule = collections.Counter((f["antipattern"], f["severity"]) for f in d)
for (rule, sev), n in by_rule.most_common():
    print(f'  {n:3d}  [{sev}] {rule}')
by_file = collections.Counter(f.get("file", "?").rsplit("/", 1)[-1] for f in d)
for name, n in sorted(by_file.items()):
    print(f'  {n:3d}  {name}')
PY
