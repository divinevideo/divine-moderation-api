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
