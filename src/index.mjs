// Divine Moderation API — public machine-to-machine worker
// No Zero Trust — authenticates via Bearer token
// Shares D1, KV, Queue, R2 with divine-moderation-service
//
// Endpoints:
//   POST /api/v1/scan          — Queue a video for moderation
//   GET  /api/v1/status/:sha256 — Check moderation result
//   POST /api/v1/batch-scan    — Queue multiple videos
//   GET  /api/v1/classifier/:sha256 — Read stored classifier payload
//   GET  /api/v1/classifier/:sha256/recommendations — Recommendation labels/features
//   GET  /check-result/:sha256 — Public moderation result
//   GET  /health               — Health check (no auth)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Health check — no auth
    if (url.pathname === '/health') {
      return corsResponse(jsonResponse(200, {
        status: 'ok',
        service: 'divine-moderation-api',
        timestamp: new Date().toISOString()
      }));
    }

    // Public result endpoint for clients such as divine-mobile.
    if (method === 'GET' && url.pathname.startsWith('/check-result/')) {
      const sha256 = url.pathname.split('/')[2];
      return corsResponse(await handleCheckResult(sha256, env));
    }

    // All other endpoints require auth
    const authError = verifyAuth(request, env);
    if (authError) return corsResponse(authError);

    try {
      // POST /api/v1/scan — queue single video for moderation
      if (method === 'POST' && url.pathname === '/api/v1/scan') {
        return corsResponse(await handleScan(request, env));
      }

      // POST /api/v1/batch-scan — queue multiple videos
      if (method === 'POST' && url.pathname === '/api/v1/batch-scan') {
        return corsResponse(await handleBatchScan(request, env));
      }

      // GET /api/v1/status/:sha256 — check moderation result
      if (method === 'GET' && url.pathname.startsWith('/api/v1/status/')) {
        const sha256 = url.pathname.split('/')[4];
        return corsResponse(await handleStatus(sha256, env));
      }

      // GET /api/v1/classifier/:sha256[/recommendations] — classifier data for enrichment
      if (method === 'GET' && url.pathname.startsWith('/api/v1/classifier/')) {
        const pathParts = url.pathname.split('/').filter(Boolean);
        const sha256 = pathParts[3];
        const subRoute = pathParts[4] || null;
        return corsResponse(await handleClassifier(sha256, subRoute, env));
      }

      return corsResponse(jsonResponse(404, { error: 'Not found' }));
    } catch (error) {
      console.error('[API] Error:', error);
      return corsResponse(jsonResponse(500, { error: error.message }));
    }
  },

  // Queue consumer is NOT here — divine-moderation-service handles that
};

/**
 * Verify Bearer token auth
 */
function verifyAuth(request, env) {
  const validTokens = getValidBearerTokens(env);

  if (validTokens.length === 0) {
    console.error('[AUTH] No API bearer token configured');
    return jsonResponse(500, { error: 'Server misconfigured — no auth token set' });
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'Missing Authorization: Bearer <token>' });
  }

  const token = authHeader.slice(7);
  if (!validTokens.includes(token)) {
    return jsonResponse(403, { error: 'Invalid token' });
  }

  return null; // Auth OK
}

function getValidBearerTokens(env) {
  return [env.API_BEARER_TOKEN, env.SERVICE_API_TOKEN, env.MODERATION_API_KEY]
    .filter((value, index, all) => typeof value === 'string' && value.length > 0 && all.indexOf(value) === index);
}

/**
 * POST /api/v1/scan
 * Queue a single video for moderation
 *
 * Body: {
 *   sha256: string (required, 64 hex chars),
 *   url?: string (video URL — if not provided, constructs from CDN_DOMAIN),
 *   source?: string (e.g. "blossom", "funnelcake", "backfill"),
 *   pubkey?: string (uploader's nostr pubkey, 64 hex chars),
 *   metadata?: { fileSize?, contentType?, duration? }
 * }
 */
async function handleScan(request, env) {
  const body = await request.json();
  const { sha256, url, source, pubkey, metadata } = body;

  // Validate sha256
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
    return jsonResponse(400, { error: 'sha256 required (64 hex characters)' });
  }

  // Check if already moderated
  const existing = await env.BLOSSOM_DB.prepare(
    'SELECT sha256, action FROM moderation_results WHERE sha256 = ?'
  ).bind(sha256.toLowerCase()).first();

  if (existing) {
    return jsonResponse(200, {
      sha256: sha256.toLowerCase(),
      status: 'already_moderated',
      action: existing.action,
      queued: false
    });
  }

  // Queue for moderation
  // Blossom serves by hash without extension at media.divine.video
  // CDN (cdn.divine.video) may also have it but uses different URL patterns
  const videoUrl = url || `https://media.divine.video/${sha256}`;

  await env.MODERATION_QUEUE.send({
    sha256: sha256.toLowerCase(),
    r2Key: `blobs/${sha256.toLowerCase()}`,
    uploadedBy: pubkey || undefined,
    uploadedAt: Date.now(),
    metadata: {
      ...(metadata || {}),
      source: source || 'api',
      videoUrl
    }
  });

  console.log(`[SCAN] Queued ${sha256} from ${source || 'api'}`);

  return jsonResponse(202, {
    sha256: sha256.toLowerCase(),
    status: 'queued',
    queued: true,
    videoUrl
  });
}

/**
 * POST /api/v1/batch-scan
 * Queue multiple videos for moderation
 *
 * Body: {
 *   videos: [{ sha256, url?, source?, pubkey?, metadata? }],
 *   source?: string (default source for all)
 * }
 */
async function handleBatchScan(request, env) {
  const body = await request.json();
  const { videos, source: defaultSource } = body;

  if (!Array.isArray(videos) || videos.length === 0) {
    return jsonResponse(400, { error: 'videos array required' });
  }

  if (videos.length > 100) {
    return jsonResponse(400, { error: 'Maximum 100 videos per batch' });
  }

  const results = [];
  let queued = 0;
  let skipped = 0;
  let errors = 0;

  for (const video of videos) {
    const { sha256, url, source, pubkey, metadata } = video;

    if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
      results.push({ sha256, status: 'error', error: 'Invalid sha256' });
      errors++;
      continue;
    }

    const hash = sha256.toLowerCase();

    // Check if already moderated
    const existing = await env.BLOSSOM_DB.prepare(
      'SELECT sha256, action FROM moderation_results WHERE sha256 = ?'
    ).bind(hash).first();

    if (existing) {
      results.push({ sha256: hash, status: 'already_moderated', action: existing.action });
      skipped++;
      continue;
    }

    const videoUrl = url || `https://media.divine.video/${hash}`;

    await env.MODERATION_QUEUE.send({
      sha256: hash,
      r2Key: `blobs/${hash}`,
      uploadedBy: pubkey || undefined,
      uploadedAt: Date.now(),
      metadata: {
        ...(metadata || {}),
        source: source || defaultSource || 'batch-api',
        videoUrl
      }
    });

    results.push({ sha256: hash, status: 'queued' });
    queued++;
  }

  console.log(`[BATCH] Queued ${queued}, skipped ${skipped}, errors ${errors}`);

  return jsonResponse(202, {
    total: videos.length,
    queued,
    skipped,
    errors,
    results
  });
}

/**
 * GET /api/v1/status/:sha256
 * Check moderation result for a video
 */
async function handleStatus(sha256, env) {
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
    return jsonResponse(400, { error: 'Invalid sha256' });
  }

  const result = await getModerationResult(sha256, env);
  return jsonResponse(200, statusPayloadFromResult(result));
}

async function handleCheckResult(sha256, env) {
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
    return jsonResponse(400, { error: 'Invalid sha256' });
  }

  const result = await getModerationResult(sha256, env);
  return jsonResponse(200, publicPayloadFromResult(result));
}

async function handleClassifier(sha256, subRoute, env) {
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
    return jsonResponse(400, { error: 'Invalid sha256 hash' });
  }

  const hash = sha256.toLowerCase();
  const classifierData = await env.MODERATION_KV.get(`classifier:${hash}`);

  if (!classifierData) {
    return jsonResponse(404, {
      sha256: hash,
      classifier_data: null,
      message: 'No classifier data available for this hash'
    });
  }

  if (subRoute === 'recommendations') {
    const parsed = JSON.parse(classifierData);
    return jsonResponse(200, await recommendationPayloadFromClassifier(hash, parsed, env));
  }

  return new Response(classifierData, {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getModerationResult(sha256, env) {
  const hash = sha256.toLowerCase();
  const result = await env.BLOSSOM_DB.prepare(`
    SELECT sha256, action, provider, scores, categories, moderated_at, reviewed_by, reviewed_at
    FROM moderation_results
    WHERE sha256 = ?
  `).bind(hash).first();

  if (!result) {
    return {
      sha256: hash,
      moderated: false,
      action: null,
      provider: null,
      scores: null,
      categories: null,
      moderated_at: null,
      reviewed_by: null,
      reviewed_at: null
    };
  }

  return {
    sha256: hash,
    moderated: true,
    action: result.action,
    provider: result.provider,
    scores: result.scores ? JSON.parse(result.scores) : null,
    categories: result.categories ? JSON.parse(result.categories) : null,
    moderated_at: result.moderated_at,
    reviewed_by: result.reviewed_by,
    reviewed_at: result.reviewed_at
  };
}

function statusPayloadFromResult(result) {
  if (!result.moderated) {
    return {
      sha256: result.sha256,
      moderated: false,
      action: null,
      message: 'No moderation result found'
    };
  }

  return {
    sha256: result.sha256,
    moderated: true,
    action: result.action,
    provider: result.provider,
    scores: result.scores,
    categories: result.categories,
    moderated_at: result.moderated_at,
    reviewed_by: result.reviewed_by,
    reviewed_at: result.reviewed_at,
    blocked: result.action === 'PERMANENT_BAN',
    age_restricted: result.action === 'AGE_RESTRICTED',
    needs_review: result.action === 'REVIEW'
  };
}

function publicPayloadFromResult(result) {
  if (!result.moderated) {
    return {
      sha256: result.sha256,
      status: 'unknown',
      moderated: false,
      blocked: false,
      age_restricted: false
    };
  }

  return {
    sha256: result.sha256,
    status: result.action.toLowerCase(),
    moderated: true,
    blocked: result.action === 'PERMANENT_BAN',
    quarantined: result.action === 'QUARANTINE',
    age_restricted: result.action === 'AGE_RESTRICTED',
    needs_review: result.action === 'REVIEW' || result.action === 'QUARANTINE' || result.action === 'PERMANENT_BAN',
    action: result.action,
    provider: result.provider,
    scores: result.scores,
    categories: result.categories,
    moderated_at: result.moderated_at,
    reviewed_by: result.reviewed_by,
    reviewed_at: result.reviewed_at
  };
}

async function recommendationPayloadFromClassifier(sha256, parsed, env) {
  const allLabels = [];
  const allFeatures = {};

  if (parsed.sceneClassification) {
    allLabels.push(...formatForGorse(parsed.sceneClassification));
    Object.assign(allFeatures, formatForFunnelcake(parsed.sceneClassification));
  }

  if (parsed.topicProfile) {
    allLabels.push(...topicsToLabels(parsed.topicProfile));
    Object.assign(allFeatures, topicsToWeightedFeatures(parsed.topicProfile));
  }

  if (parsed.rawClassifierData?.maxScores) {
    for (const [key, value] of Object.entries(parsed.rawClassifierData.maxScores)) {
      if (typeof value === 'number') {
        allFeatures[key] = value;
      }
    }
  }

  const moderationResult = await env.BLOSSOM_DB.prepare(
    'SELECT action FROM moderation_results WHERE sha256 = ?'
  ).bind(sha256).first();

  const action = moderationResult?.action || 'UNKNOWN';

  return {
    sha256,
    gorse: {
      labels: [...new Set(allLabels)],
      features: allFeatures
    },
    description: parsed.sceneClassification?.description || null,
    primary_topic: parsed.topicProfile?.primary_topic || null,
    has_speech: parsed.topicProfile?.has_speech || false,
    is_safe: action === 'SAFE',
    action
  };
}

function formatForGorse(classificationResult) {
  if (!classificationResult || classificationResult.skipped) {
    return [];
  }

  return (classificationResult.labels || []).map(
    ({ label, namespace }) => `${namespace}:${label}`
  );
}

function formatForFunnelcake(classificationResult) {
  if (!classificationResult || classificationResult.skipped) {
    return {};
  }

  const features = {};
  for (const { label, namespace, score } of (classificationResult.labels || [])) {
    features[`${namespace}:${label}`] = score;
  }
  return features;
}

function topicsToLabels(result, minConfidence = 0.3) {
  if (!result || !result.topics) {
    return [];
  }

  return result.topics
    .filter((topic) => topic.confidence >= minConfidence)
    .map((topic) => `topic:${topic.category}`);
}

function topicsToWeightedFeatures(result, minConfidence = 0.15) {
  if (!result || !result.topics) {
    return {};
  }

  const features = {};
  for (const topic of result.topics) {
    if (topic.confidence >= minConfidence) {
      features[`topic:${topic.category}`] = topic.confidence;
    }
  }
  return features;
}

// --- Helpers ---

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function corsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
