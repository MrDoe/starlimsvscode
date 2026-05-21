import * as assert from 'assert';
import { createServer, IncomingMessage, request as httpRequest, Server as HttpServer } from 'http';
import { ExpressServer } from '../../services/expressServer';

type RequestResult = {
  body: string;
  headers: IncomingMessage['headers'];
  statusCode: number;
};

function closeHttpServer(server: HttpServer | undefined): Promise<void> {
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve free port.')));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.once('error', reject);
  });
}

function postJson(port: number, path: string, payload: unknown): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, number | string> = {};
    headers['Content-Length'] = Buffer.byteLength(body);
    headers['Content-Type'] = 'application/json';

    const req = httpRequest(
      {
        host: '127.0.0.1',
        method: 'POST',
        path,
        port,
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
            statusCode: res.statusCode ?? 0
          });
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJson(port: number, path: string): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        method: 'GET',
        path,
        port
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
            statusCode: res.statusCode ?? 0
          });
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

suite('ExpressServer OpenCode proxy', () => {
  let createdSessionIds: string[] = [];
  let deletedSessionIds: string[] = [];
  let messageRequests: Array<{ prompt: string; sessionId: string }> = [];
  let targetServer: HttpServer | undefined;
  let proxyServer: ExpressServer | undefined;
  let proxyPort = 0;

  setup(async () => {
    createdSessionIds = [];
    deletedSessionIds = [];
    messageRequests = [];

    const targetPort = await getFreePort();
    proxyPort = await getFreePort();

    targetServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        const responseHeaders: Record<string, string> = {};
        responseHeaders['Content-Type'] = 'application/json';

        if (req.method === 'POST' && req.url === '/session') {
          const sessionId = `ses_${createdSessionIds.length + 1}`;
          createdSessionIds.push(sessionId);
          res.writeHead(200, responseHeaders);
          res.end(JSON.stringify({ id: sessionId }));
          return;
        }

        const messageMatch = req.method === 'POST' ? req.url?.match(/^\/session\/([^/]+)\/message$/) : undefined;
        if (messageMatch) {
          const requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            parts: Array<{ text?: string; type: string }>;
          };
          const prompt = requestBody.parts
            .filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('');
          messageRequests.push({ prompt, sessionId: messageMatch[1] });
          res.writeHead(200, responseHeaders);
          res.end(JSON.stringify({ parts: [{ type: 'text', text: 'pong' }] }));
          return;
        }

        const deleteMatch = req.method === 'DELETE' ? req.url?.match(/^\/session\/([^/]+)$/) : undefined;
        if (deleteMatch) {
          deletedSessionIds.push(deleteMatch[1]);
          res.writeHead(200, responseHeaders);
          res.end(JSON.stringify(true));
          return;
        }

        res.writeHead(200, responseHeaders);
        res.end(JSON.stringify({ error: 'unexpected request' }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      targetServer!.listen(targetPort, '127.0.0.1', () => resolve());
      targetServer!.once('error', reject);
    });

    proxyServer = new ExpressServer({
      host: '127.0.0.1',
      onOpenCodeBehind: async () => undefined,
      opencodeProxyEnabled: true,
      opencodeProxyHost: '127.0.0.1',
      opencodeProxyPort: proxyPort,
      opencodeProxyTargetUrl: `http://127.0.0.1:${targetPort}`
    });

    await proxyServer.start();
  });

  teardown(async () => {
    if (proxyServer) {
      await proxyServer.stop();
      proxyServer = undefined;
    }

    await closeHttpServer(targetServer);
    targetServer = undefined;
  });

  test('accepts bare and versioned chat completion routes', async () => {
    const requestBody = {
      messages: [{ role: 'user', content: 'ping' }],
      model: 'opencode-go',
      stream: false
    };

    const bareResponse = await postJson(proxyPort, '/chat/completions', requestBody);
    const versionedResponse = await postJson(proxyPort, '/v1/chat/completions', requestBody);

    assert.strictEqual(bareResponse.statusCode, 200);
    assert.strictEqual(versionedResponse.statusCode, 200);
    assert.strictEqual(JSON.parse(bareResponse.body).choices[0].message.content, 'pong');
    assert.strictEqual(JSON.parse(versionedResponse.body).choices[0].message.content, 'pong');
    assert.deepStrictEqual(messageRequests, [
      { prompt: 'user: ping', sessionId: 'ses_1' },
      { prompt: 'user: ping', sessionId: 'ses_2' }
    ]);
    assert.deepStrictEqual(createdSessionIds, ['ses_1', 'ses_2']);
    assert.deepStrictEqual(deletedSessionIds, ['ses_1', 'ses_2']);
  });

  test('accepts bare and versioned model routes', async () => {
    const bareResponse = await getJson(proxyPort, '/models');
    const versionedResponse = await getJson(proxyPort, '/v1/models');

    assert.strictEqual(bareResponse.statusCode, 200);
    assert.strictEqual(versionedResponse.statusCode, 200);
    assert.strictEqual(JSON.parse(bareResponse.body).data[0].id, 'opencode-go');
    assert.strictEqual(JSON.parse(versionedResponse.body).data[0].id, 'opencode-go');
  });
});