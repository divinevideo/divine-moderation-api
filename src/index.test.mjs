import { describe, expect, it } from 'vitest';
import worker from './index.mjs';

const SHA256 = 'a'.repeat(64);

function createDbMock({ moderationResults = new Map() } = {}) {
  return {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...args) {
          bindings = args;
          return this;
        },
        async first() {
          if (sql.includes('FROM moderation_results') && sql.includes('WHERE sha256 = ?')) {
            return moderationResults.get(bindings[0]) ?? null;
          }
          return null;
        }
      };
    }
  };
}

function createEnv(overrides = {}) {
  return {
    API_BEARER_TOKEN: 'legacy-token',
    BLOSSOM_DB: createDbMock(),
    MODERATION_KV: {
      async get() {
        return null;
      }
    },
    MODERATION_QUEUE: {
      async send() {}
    },
    ...overrides
  };
}

describe('divine-moderation-api', () => {
  it('uses wildcard cors on public preflight', async () => {
    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/health', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://evil.example',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Content-Type,X-Requested-With'
        }
      }),
      createEnv()
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, X-Requested-With');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(response.headers.get('Vary')).toBeNull();
  });

  it('echoes approved app origin on protected preflight', async () => {
    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/scan', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://app.divine.video',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type,Authorization,X-Requested-With'
        }
      }),
      createEnv()
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.divine.video');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization, X-Requested-With');
    expect(response.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('does not allow unknown origins on protected preflight', async () => {
    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/scan', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type,Authorization,X-Requested-With'
        }
      }),
      createEnv()
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('does not allow the preview apex on protected preflight', async () => {
    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/scan', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://openvine-app.pages.dev',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type,Authorization,X-Requested-With'
        }
      }),
      createEnv()
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('serves public /check-result without auth', async () => {
    const env = createEnv({
      BLOSSOM_DB: createDbMock({
        moderationResults: new Map([[SHA256, {
          sha256: SHA256,
          action: 'SAFE',
          provider: 'hiveai',
          scores: JSON.stringify({ nudity: 0.01 }),
          categories: JSON.stringify(['safe']),
          moderated_at: '2026-03-07T00:00:00.000Z',
          reviewed_by: null,
          reviewed_at: null
        }]])
      })
    });

    const response = await worker.fetch(
      new Request(`https://moderation-api.divine.video/check-result/${SHA256}`),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await expect(response.json()).resolves.toMatchObject({
      sha256: SHA256,
      moderated: true,
      action: 'SAFE',
      status: 'safe'
    });
  });

  it('uses wildcard cors on public actual responses', async () => {
    const response = await worker.fetch(
      new Request(`https://moderation-api.divine.video/check-result/${SHA256}`, {
        headers: {
          'Origin': 'https://pr-123.openvine-app.pages.dev'
        }
      }),
      createEnv()
    );

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, X-Requested-With');
    expect(response.headers.get('Vary')).toBeNull();
  });

  it('does not allow unknown origins on protected actual responses', async () => {
    const response = await worker.fetch(
      new Request(`https://moderation-api.divine.video/api/v1/status/${SHA256}`, {
        headers: {
          'Authorization': 'Bearer legacy-token',
          'Origin': 'https://evil.example'
        }
      }),
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization, X-Requested-With');
  });

  it('accepts SERVICE_API_TOKEN as bearer auth', async () => {
    const queued = [];
    const env = createEnv({
      API_BEARER_TOKEN: undefined,
      SERVICE_API_TOKEN: 'service-token',
      MODERATION_QUEUE: {
        async send(message) {
          queued.push(message);
        }
      }
    });

    const response = await worker.fetch(
      new Request('https://moderation-api.divine.video/api/v1/scan', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer service-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sha256: SHA256, source: 'mobile' })
      }),
      env
    );

    expect(response.status).toBe(202);
    expect(queued).toHaveLength(1);
  });

  it('returns legacy 401 shape for missing bearer token', async () => {
    const response = await worker.fetch(
      new Request(`https://moderation-api.divine.video/api/v1/status/${SHA256}`),
      createEnv()
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Missing Authorization: Bearer <token>'
    });
  });

  it('returns stored classifier payloads', async () => {
    const classifierPayload = JSON.stringify({
      sha256: SHA256,
      sceneClassification: {
        description: 'A person singing into a microphone',
        labels: [
          { namespace: 'topic', label: 'music', score: 0.91 },
          { namespace: 'object', label: 'microphone', score: 0.88 }
        ]
      },
      topicProfile: {
        primary_topic: 'music',
        has_speech: true,
        topics: [{ category: 'music', confidence: 0.82 }]
      },
      rawClassifierData: {
        maxScores: { safe: 0.98, ai_generated: 0.14 }
      }
    });

    const response = await worker.fetch(
      new Request(`https://moderation-api.divine.video/api/v1/classifier/${SHA256}`, {
        headers: { Authorization: 'Bearer legacy-token' }
      }),
      createEnv({
        MODERATION_KV: {
          async get(key) {
            return key === `classifier:${SHA256}` ? classifierPayload : null;
          }
        }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sha256: SHA256,
      sceneClassification: {
        description: 'A person singing into a microphone'
      }
    });
  });

  it('returns recommendation payloads from stored classifier data', async () => {
    const response = await worker.fetch(
      new Request(`https://moderation-api.divine.video/api/v1/classifier/${SHA256}/recommendations`, {
        headers: { Authorization: 'Bearer legacy-token' }
      }),
      createEnv({
        BLOSSOM_DB: createDbMock({
          moderationResults: new Map([[SHA256, { action: 'SAFE' }]])
        }),
        MODERATION_KV: {
          async get(key) {
            if (key !== `classifier:${SHA256}`) {
              return null;
            }

            return JSON.stringify({
              sha256: SHA256,
              sceneClassification: {
                description: 'A person singing into a microphone',
                labels: [
                  { namespace: 'topic', label: 'music', score: 0.91 },
                  { namespace: 'object', label: 'microphone', score: 0.88 }
                ]
              },
              topicProfile: {
                primary_topic: 'music',
                has_speech: true,
                topics: [
                  { category: 'music', confidence: 0.82 },
                  { category: 'comedy', confidence: 0.12 }
                ]
              },
              rawClassifierData: {
                maxScores: { safe: 0.98, ai_generated: 0.14 }
              }
            });
          }
        }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sha256: SHA256,
      gorse: {
        labels: ['topic:music', 'object:microphone'],
        features: {
          'topic:music': 0.82,
          'object:microphone': 0.88,
          safe: 0.98,
          ai_generated: 0.14
        }
      },
      description: 'A person singing into a microphone',
      primary_topic: 'music',
      has_speech: true,
      is_safe: true,
      action: 'SAFE'
    });
  });
});
