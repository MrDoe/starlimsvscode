import * as assert from 'assert';
import { OpenCodeServerService } from '../../services/opencodeServerService';

const MODELS = [
  { id: 'model-one', modelID: '/backend/model-one', providerID: 'provider-a' },
  { id: 'model-two', providerID: 'provider-b' }
];

type RecordedRequest = { method: string; path: string; body?: Record<string, unknown> };

suite('OpenCodeServerService model enforcement', () => {
  const originalFetch = globalThis.fetch;
  let requests: RecordedRequest[] = [];
  let sessionModel: { id: string; providerID: string } | undefined;
  let createResponseModel: { id: string; providerID: string } | undefined;

  function createService(): OpenCodeServerService {
    return new OpenCodeServerService({
      hostname: '127.0.0.1',
      port: 4096,
      command: 'opencode',
      commandArgs: [],
      workingDirectory: process.cwd(),
      password: 'test-password',
      log: () => undefined
    });
  }

  function sessionPosts(): RecordedRequest[] {
    return requests.filter((request) => request.method === 'POST' && request.path === '/api/session');
  }

  setup(() => {
    requests = [];
    sessionModel = undefined;
    createResponseModel = undefined;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url).pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : undefined;
      requests.push({ method, path, body });

      if (path === '/api/info') {
        return new Response(JSON.stringify({ version: 'test', pid: 1 }), { status: 200 });
      }
      if (path === '/api/model' && method === 'GET') {
        return new Response(JSON.stringify({ data: MODELS }), { status: 200 });
      }
      if (path === '/api/session' && method === 'POST') {
        sessionModel = createResponseModel ?? body?.model as { id: string; providerID: string } | undefined;
        return new Response(JSON.stringify({ data: { id: 'ses_test', model: sessionModel } }), { status: 200 });
      }
      if (path === '/api/session/ses_test' && method === 'GET') {
        return new Response(JSON.stringify({ data: { id: 'ses_test', model: sessionModel } }), { status: 200 });
      }
      if (path === '/api/session/ses_test/model' && method === 'POST') {
        sessionModel = body?.model as { id: string; providerID: string } | undefined;
        return new Response(null, { status: 204 });
      }
      if (path === '/api/session/ses_test/prompt' && method === 'POST') {
        return new Response(JSON.stringify({ data: { time: { created: 123 } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: `unexpected ${method} ${path}` }), { status: 404 });
    }) as typeof fetch;
  });

  teardown(() => {
    globalThis.fetch = originalFetch;
  });

  test('resolves a configured model by id, provider/id, backend modelID and case-insensitively', async () => {
    const service = createService();
    await service.ensureServer();

    assert.deepStrictEqual(
      await service.requireModel('model-one', 'STARLIMS.opencode.planModel'),
      { providerID: 'provider-a', modelID: 'model-one' }
    );
    assert.deepStrictEqual(
      await service.requireModel('provider-a/model-one'),
      { providerID: 'provider-a', modelID: 'model-one' }
    );
    assert.deepStrictEqual(
      await service.requireModel('/backend/model-one'),
      { providerID: 'provider-a', modelID: 'model-one' }
    );
    assert.deepStrictEqual(
      await service.requireModel('MODEL-ONE'),
      { providerID: 'provider-a', modelID: 'model-one' }
    );
  });

  test('rejects an unknown or empty model instead of falling back', async () => {
    const service = createService();
    await service.ensureServer();

    await assert.rejects(
      () => service.requireModel('missing-model', 'STARLIMS.opencode.buildModel'),
      (error: Error) =>
        error.message.includes('STARLIMS.opencode.buildModel') &&
        error.message.includes('provider-a/model-one')
    );

    await assert.rejects(
      () => service.requireModel('', 'STARLIMS.opencode.planModel'),
      /No OpenCode model is configured in STARLIMS\.opencode\.planModel/
    );
  });

  test('createSession binds the configured model and verifies it', async () => {
    const service = createService();
    await service.ensureServer();

    const sessionId = await service.createSession('Ticket #1', {
      agent: 'plan',
      model: 'model-one',
      modelSetting: 'STARLIMS.opencode.planModel'
    });

    assert.strictEqual(sessionId, 'ses_test');
    assert.deepStrictEqual(sessionPosts()[0].body, {
      title: 'Ticket #1',
      agent: 'plan',
      model: { id: 'model-one', providerID: 'provider-a' }
    });
  });

  test('createSession rejects an empty model before creating a session', async () => {
    const service = createService();
    await service.ensureServer();

    await assert.rejects(
      () => service.createSession('Ticket #1', {
        model: '',
        modelSetting: 'STARLIMS.opencode.planModel'
      }),
      /No OpenCode model is configured/
    );
    assert.strictEqual(sessionPosts().length, 0);
  });

  test('createSession fails when the server applies a different model', async () => {
    const service = createService();
    await service.ensureServer();
    createResponseModel = { id: 'model-two', providerID: 'provider-b' };

    await assert.rejects(
      () => service.createSession('Ticket #1', {
        model: 'model-one',
        modelSetting: 'STARLIMS.opencode.planModel'
      }),
      /not using the model "model-one" configured in STARLIMS\.opencode\.planModel/
    );
  });

  test('sendMessage rejects an unknown model before queuing the prompt', async () => {
    const service = createService();
    await service.ensureServer();

    await assert.rejects(
      () => service.sendMessage('ses_test', 'Hello', {
        model: 'missing-model',
        modelSetting: 'STARLIMS.opencode.buildModel'
      }),
      /not available on the OpenCode server/
    );
    assert.ok(!requests.some((request) => request.path === '/api/session/ses_test/prompt'));
  });

  test('sendMessage switches and verifies the model before queuing the prompt', async () => {
    const service = createService();
    await service.ensureServer();
    sessionModel = { id: 'model-two', providerID: 'provider-b' };

    await service.sendMessage('ses_test', 'Hello', {
      model: 'model-one',
      modelSetting: 'STARLIMS.opencode.buildModel'
    });

    const switchIndex = requests.findIndex((request) => request.path === '/api/session/ses_test/model');
    const promptIndex = requests.findIndex((request) => request.path === '/api/session/ses_test/prompt');
    assert.ok(switchIndex >= 0, 'model switch must be sent');
    assert.ok(promptIndex > switchIndex, 'prompt must follow the model switch');
    assert.deepStrictEqual(requests[switchIndex].body, {
      model: { id: 'model-one', providerID: 'provider-a' }
    });
    assert.deepStrictEqual(sessionModel, { id: 'model-one', providerID: 'provider-a' });
  });
});
