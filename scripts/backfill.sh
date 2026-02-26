#!/bin/bash
# Backfill moderation for all existing videos via funnelcake API + moderation API
set -euo pipefail

TOKEN="${MODERATION_API_TOKEN:-1ccf0059b75d5c12105c51e104b532c7bc317bddf2a819547305675cc93d0dee}"
API="https://moderation-api.divine.video"
FUNNELCAKE="https://relay.dvines.org"
BATCH=50
DRY_RUN="${1:-}"

echo "=== Divine Video Moderation Backfill ==="

# Step 1: Fetch all video hashes from funnelcake
echo "Fetching videos from funnelcake..."
ALL_HASHES=$(curl -s "$FUNNELCAKE/api/videos?limit=10000&sort=recent" | python3 -c "
import sys, json
data = json.load(sys.stdin)
seen = set()
for v in data:
    url = v.get('video_url', '')
    # Extract hash from https://media.divine.video/{hash}
    if 'media.divine.video/' in url:
        h = url.split('media.divine.video/')[-1].split('.')[0].split('?')[0]
        if len(h) == 64 and h not in seen:
            seen.add(h)
            print(h)
")

TOTAL=$(echo "$ALL_HASHES" | grep -c '.' || echo 0)
echo "Found $TOTAL unique video hashes"

if [[ "$TOTAL" -eq 0 ]]; then
  echo "No videos found"
  exit 0
fi

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "[DRY RUN] Would scan $TOTAL videos"
  echo "$ALL_HASHES" | head -5
  echo "..."
  exit 0
fi

# Step 2: Batch scan
echo ""
echo "Submitting in batches of $BATCH..."
QUEUED=0
SKIPPED=0
BATCH_NUM=0

echo "$ALL_HASHES" | while IFS= read -r hash; do
  BATCH_HASHES+=("$hash")
  
  if [[ ${#BATCH_HASHES[@]} -ge $BATCH ]]; then
    BATCH_NUM=$((BATCH_NUM + 1))
    
    VIDEOS_JSON=$(printf '%s\n' "${BATCH_HASHES[@]}" | python3 -c "
import sys, json
videos = [{'sha256': l.strip()} for l in sys.stdin if l.strip()]
print(json.dumps({'videos': videos, 'source': 'backfill'}))
")
    
    RESULT=$(curl -s -X POST "$API/api/v1/batch-scan" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$VIDEOS_JSON")
    
    Q=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('queued',0))" 2>/dev/null || echo 0)
    S=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('skipped',0))" 2>/dev/null || echo 0)
    
    echo "  Batch $BATCH_NUM: queued=$Q skipped=$S"
    
    BATCH_HASHES=()
    sleep 1
  fi
done

# Handle remaining
if [[ ${#BATCH_HASHES[@]} -gt 0 ]]; then
  VIDEOS_JSON=$(printf '%s\n' "${BATCH_HASHES[@]}" | python3 -c "
import sys, json
videos = [{'sha256': l.strip()} for l in sys.stdin if l.strip()]
print(json.dumps({'videos': videos, 'source': 'backfill'}))
")
  
  RESULT=$(curl -s -X POST "$API/api/v1/batch-scan" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$VIDEOS_JSON")
  
  Q=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('queued',0))" 2>/dev/null || echo 0)
  S=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('skipped',0))" 2>/dev/null || echo 0)
  echo "  Final batch: queued=$Q skipped=$S"
fi

echo ""
echo "=== Backfill submitted ==="
echo "Videos will be processed asynchronously. Check moderation.admin.divine.video for results."
