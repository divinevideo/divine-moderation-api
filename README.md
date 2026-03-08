# Divine Moderation API

Public-facing machine-to-machine API for divine video content moderation. This is a thin Cloudflare Worker that accepts scan requests and queues them for the [divine-moderation-service](https://github.com/divinevideo/divine-moderation-service) to process.

**No Zero Trust** — authenticates via Bearer token. Designed to be called by:
- **divine-blossom** (Fastly) — on video upload
- **divine-funnelcake** (relay) — on new video events from any blossom server
- **Enrichment jobs** — for classifier labels and recommendation features
- **Backfill scripts** — for scanning existing unmoderated videos

## Architecture

```
Blossom (Fastly) ──POST /api/v1/scan──→ [moderation-api worker]
                                              │
Funnelcake (relay) ──POST /api/v1/scan──→     │
                                              ▼
                                        CF Queue
                                              │
                                              ▼
                                   [divine-moderation-service]
                                        │           │
                                        ▼           ▼
                                   Hive AI     D1 + KV
                                                    │
                                                    ▼
                                        POST /admin/moderate
                                              │
                                              ▼
                                     Blossom (updates blob status)
```

## Endpoints

### `POST /api/v1/scan`

Queue a single video for moderation.

```bash
curl -X POST https://moderation-api.divine.video/api/v1/scan \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sha256": "abc123...", "source": "blossom"}'
```

**Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sha256` | string | yes | 64 hex character video hash |
| `url` | string | no | Video URL (defaults to `cdn.divine.video/{sha256}.mp4`) |
| `source` | string | no | Origin identifier (e.g. "blossom", "funnelcake") |
| `pubkey` | string | no | Uploader's nostr pubkey (64 hex chars) |
| `metadata` | object | no | Additional metadata (fileSize, contentType, duration) |

**Response (202):**
```json
{ "sha256": "abc123...", "status": "queued", "queued": true, "videoUrl": "..." }
```

If already moderated, returns 200 with existing result.

### `POST /api/v1/batch-scan`

Queue up to 100 videos at once.

```bash
curl -X POST https://moderation-api.divine.video/api/v1/batch-scan \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"videos": [{"sha256": "abc..."}, {"sha256": "def..."}], "source": "backfill"}'
```

### `GET /api/v1/status/:sha256`

Check moderation result.

```bash
curl https://moderation-api.divine.video/api/v1/status/abc123... \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /api/v1/classifier/:sha256`

Read the stored classifier payload for a moderated video.

```bash
curl https://moderation-api.divine.video/api/v1/classifier/abc123... \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /api/v1/classifier/:sha256/recommendations`

Read the recommendation-friendly labels and weighted features used by Funnelcake and Gorse.

```bash
curl https://moderation-api.divine.video/api/v1/classifier/abc123.../recommendations \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /check-result/:sha256`

Public moderation lookup for external clients such as divine-mobile.

```bash
curl https://moderation-api.divine.video/check-result/abc123...
```

### `GET /health`

No auth required. Returns service status.

## Setup

```bash
npm install

# Set the Bearer token for API auth
wrangler secret put API_BEARER_TOKEN
# Or reuse the secret name already present in divine-moderation-service
wrangler secret put SERVICE_API_TOKEN

# Deploy
wrangler deploy
```

## Integration

### Blossom (Fastly/Rust)

After upload completes, POST to scan endpoint:

```rust
// In upload handler, after storing blob
let moderation_url = "https://moderation-api.divine.video/api/v1/scan";
let body = json!({
    "sha256": sha256,
    "source": "blossom",
    "pubkey": owner_pubkey
});
// Fire-and-forget HTTP POST (don't block upload response)
```

### Funnelcake (relay)

After accepting a video event, extract sha256 from imeta and POST:

```rust
// In handle_event, after event is accepted
if event.is_video() {
    // Extract video URL + sha256 from imeta tags
    // POST to moderation-api.divine.video/api/v1/scan
}
```
