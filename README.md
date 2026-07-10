# Divine Moderation API

Public-facing, machine-to-machine API for Divine video content moderation. It is a thin Cloudflare Worker that accepts scan requests, queues videos for the [divine-moderation-service](https://github.com/divinevideo/divine-moderation-service) to process, and exposes read endpoints for checking results and classifier data. This Worker only produces queue messages and reads shared storage — the moderation work itself happens in divine-moderation-service.

There is no Cloudflare Zero Trust in front of the Worker. Write and read endpoints authenticate with a Bearer token; a single public read endpoint (`/check-result/:sha256`) and the health check are open. It is designed to be called by upload and relay services, enrichment jobs, and backfill scripts.

## Architecture

```
Upload / relay clients ──POST /api/v1/scan──→ [divine-moderation-api worker]
                                                     │  (producer)
                                                     ▼
                                              video-moderation-queue
                                                     │  (consumer)
                                                     ▼
                                          [divine-moderation-service]
                                                     │
                                        writes results to D1 + KV
                                                     │
        GET status / classifier / check-result ◀─────┘
                     (served by this worker)
```

The Worker shares its D1 database, KV namespace, moderation queue, and R2 bucket with divine-moderation-service. When a client submits a scan, the Worker enqueues a job and returns immediately; the service consumes the queue, runs classification, and writes the outcome back to the shared D1 database and KV. Clients then read those results through this Worker's status, classifier, and check-result endpoints.

## Endpoints

All `/api/v1/*` endpoints and `POST` routes require a Bearer token. `GET /check-result/:sha256` and `GET /health` are public.

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
| `url` | string | no | Video URL. Defaults to `https://media.divine.video/{sha256}` |
| `source` | string | no | Origin identifier (e.g. `blossom`, `funnelcake`, `backfill`) |
| `pubkey` | string | no | Uploader's Nostr pubkey (64 hex chars) |
| `metadata` | object | no | Additional metadata (e.g. `fileSize`, `contentType`, `duration`) |

**Response (202):**

```json
{ "sha256": "abc123...", "status": "queued", "queued": true, "videoUrl": "https://media.divine.video/abc123..." }
```

If the video has already been moderated, the endpoint returns `200` with `status: "already_moderated"` and the existing action instead of re-queuing.

### `POST /api/v1/batch-scan`

Queue up to 100 videos in one request.

```bash
curl -X POST https://moderation-api.divine.video/api/v1/batch-scan \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"videos": [{"sha256": "abc..."}, {"sha256": "def..."}], "source": "backfill"}'
```

The request body takes a `videos` array (each entry accepts the same fields as `/scan`) and an optional top-level `source` used as the default for entries that don't set their own. The response (`202`) reports `total`, `queued`, `skipped`, `errors`, and a per-video `results` array. Already-moderated hashes are skipped; invalid hashes are counted as errors.

### `GET /api/v1/status/:sha256`

Check the moderation result for a video.

```bash
curl https://moderation-api.divine.video/api/v1/status/abc123... \
  -H "Authorization: Bearer $TOKEN"
```

Returns `moderated: false` when no result exists yet. Once moderated, the payload includes the `action`, `provider`, `scores`, `categories`, review metadata, and convenience booleans (`blocked`, `age_restricted`, `needs_review`) derived from the action.

### `GET /api/v1/classifier/:sha256`

Read the raw stored classifier payload for a video from KV. Returns `404` when no classifier data is stored for the hash.

```bash
curl https://moderation-api.divine.video/api/v1/classifier/abc123... \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /api/v1/classifier/:sha256/recommendations`

Read recommendation-friendly labels and weighted features derived from the stored classifier payload (scene classification and topic profile), shaped for downstream recommendation and enrichment consumers.

```bash
curl https://moderation-api.divine.video/api/v1/classifier/abc123.../recommendations \
  -H "Authorization: Bearer $TOKEN"
```

### `GET /check-result/:sha256`

Public moderation lookup for external clients such as divine-mobile. No auth required. Returns a simplified payload with `status`, `moderated`, and safety booleans (`blocked`, `quarantined`, `age_restricted`, `needs_review`).

```bash
curl https://moderation-api.divine.video/check-result/abc123...
```

### `GET /health`

No auth required. Returns service status and a timestamp.

```bash
curl https://moderation-api.divine.video/health
```

## Getting started

```bash
npm install       # install dependencies
npm run dev       # run the Worker locally with Wrangler
npm test          # run the Vitest suite
npm run deploy    # deploy through Wrangler
```

Set at least one Bearer token secret before deploying (see Configuration).

## Configuration

Bindings and variables are defined in `wrangler.toml`. The Worker shares its D1, KV, queue, and R2 resources with divine-moderation-service.

**Bindings:**

| Binding | Type | Resource |
|---------|------|----------|
| `MODERATION_KV` | KV namespace | Shared moderation KV (stores classifier payloads) |
| `BLOSSOM_DB` | D1 database | `blossom-webhook-events` (reads `moderation_results`) |
| `MODERATION_QUEUE` | Queue producer | `video-moderation-queue` |
| `R2_VIDEOS` | R2 bucket | `nostrvine-media` |

**Vars:**

| Var | Value |
|-----|-------|
| `CDN_DOMAIN` | `media.divine.video` |

**Secrets** (set with `wrangler secret put <NAME>`):

The Worker accepts any of these three names as a valid Bearer token, so it can share a secret with divine-moderation-service or accept a client-specific name:

- `API_BEARER_TOKEN`
- `SERVICE_API_TOKEN`
- `MODERATION_API_KEY`

At least one must be set, or authenticated endpoints return `500`.

```bash
wrangler secret put API_BEARER_TOKEN
```

**CORS:** cross-origin responses are restricted. The Worker echoes `Access-Control-Allow-Origin` only for `https://app.divine.video` and HTTPS preview deployments on the `*.openvine-app.pages.dev` domain; all other origins receive no allow-origin header.

## Deployment

The Worker is routed at `moderation-api.divine.video/*` in the `divine.video` zone. Deploy with Wrangler:

```bash
npm run deploy
# or
wrangler deploy
```

Pull requests are checked for Conventional Commit titles by the Semantic PR workflow in `.github/workflows/`.

---

Part of [Divine](https://divine.video) — your playground for human creativity · [Brand guidelines](https://github.com/divinevideo/brand-guidelines)
