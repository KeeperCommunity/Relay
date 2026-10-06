import express from 'express';
import { AddressInfo } from 'net';
import { appIdRateLimiter } from '../../middleware/appIdRateLimiter';
import { ipRateLimiter } from '../../middleware/ipRateLimiter';

const rateLimitConfig = require('../../config/rateLimitConfig');

const startServer = async (app: express.Express) =>
  new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done, reject) => {
            server.close((err?: Error) => {
              if (err) reject(err);
              else done();
            });
          }),
      });
    });
  });

const postJson = async (url: string, payload: any, headers: Record<string, string> = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
};

describe('rate limit integration for /chat and /submitHelpIssue', () => {
  const originalChatLimit = rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY;
  const originalMessageLimit = rateLimitConfig.CHAT_MESSAGE_LIMIT;
  const originalIssueLimit = rateLimitConfig.HELP_ISSUE_LIMIT_PER_DAY;
  const originalMultiplier = rateLimitConfig.IP_RATE_LIMIT_MULTIPLIER;

  beforeEach(() => {
    rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY = 2;
    rateLimitConfig.CHAT_MESSAGE_LIMIT = 3;
    rateLimitConfig.HELP_ISSUE_LIMIT_PER_DAY = 1;
    rateLimitConfig.IP_RATE_LIMIT_MULTIPLIER = 10;
  });

  afterAll(() => {
    rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY = originalChatLimit;
    rateLimitConfig.CHAT_MESSAGE_LIMIT = originalMessageLimit;
    rateLimitConfig.HELP_ISSUE_LIMIT_PER_DAY = originalIssueLimit;
    rateLimitConfig.IP_RATE_LIMIT_MULTIPLIER = originalMultiplier;
  });

  it('enforces /chat appId limit and returns 429', async () => {
    const app = express();
    app.use(express.json());

    const shouldCountNewChat = (req: any) =>
      !Array.isArray(req?.body?.messages) || req.body.messages.length === 0;

    app.post(
      "/chat",
      appIdRateLimiter({ scope: "chat", shouldCount: shouldCountNewChat }),
      ipRateLimiter({ scope: "chat", shouldCount: shouldCountNewChat }),
      appIdRateLimiter({ scope: "chatMessage" }),
      ipRateLimiter({ scope: "chatMessage" }),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const server = await startServer(app);

    try {
      const headers = { 'x-app-id': 'chat-app-1' };

      const r1 = await postJson(`${server.baseUrl}/chat`, { hello: 'world' }, headers);
      const r2 = await postJson(`${server.baseUrl}/chat`, { hello: 'world' }, headers);
      const r3 = await postJson(`${server.baseUrl}/chat`, { hello: 'world' }, headers);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(429);
      expect(r3.data).toEqual({ error: 'HELP_AI_NEW_CHAT_LIMIT_REACHED' });

      const existingChatReq = await postJson(
        `${server.baseUrl}/chat`,
        { messages: [{ role: 'user', text: 'existing chat message' }] },
        headers
      );
      expect(existingChatReq.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("enforces independent /chat message daily limit for all chat requests", async () => {
    const app = express();
    app.use(express.json());

    const shouldCountNewChat = (req: any) =>
      !Array.isArray(req?.body?.messages) || req.body.messages.length <= 1;

    app.post(
      "/chat",
      appIdRateLimiter({ scope: "chat", shouldCount: shouldCountNewChat }),
      ipRateLimiter({ scope: "chat", shouldCount: shouldCountNewChat }),
      appIdRateLimiter({ scope: "chatMessage" }),
      ipRateLimiter({ scope: "chatMessage" }),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );

    const server = await startServer(app);

    try {
      const headers = { "x-app-id": "chat-app-message-limit" };

      const r1 = await postJson(
        `${server.baseUrl}/chat`,
        { messages: [] },
        headers,
      );
      const r2 = await postJson(
        `${server.baseUrl}/chat`,
        {
          messages: [
            { role: "user", text: "m1" },
            { role: "ai", text: "a1" },
          ],
        },
        headers,
      );
      const r3 = await postJson(
        `${server.baseUrl}/chat`,
        {
          messages: [
            { role: "user", text: "m2" },
            { role: "ai", text: "a2" },
          ],
        },
        headers,
      );
      const r4 = await postJson(
        `${server.baseUrl}/chat`,
        {
          messages: [
            { role: "user", text: "m3" },
            { role: "ai", text: "a3" },
          ],
        },
        headers,
      );

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      expect(r4.status).toBe(429);
      expect(r4.data).toEqual({ error: "HELP_AI_DAILY_MESSAGE_LIMIT_REACHED" });
    } finally {
      await server.close();
    }
  });

  it('enforces /submitHelpIssue scope limit and returns 429', async () => {
    const app = express();
    app.use(express.json());

    app.post(
      '/submitHelpIssue',
      appIdRateLimiter({ scope: 'helpIssue' }),
      ipRateLimiter({ scope: 'helpIssue' }),
      (_req, res) => {
        res.status(200).json({ submitted: true });
      }
    );

    const server = await startServer(app);

    try {
      const payload = { appId: 'issue-app-1', title: 'Test issue' };

      const r1 = await postJson(`${server.baseUrl}/submitHelpIssue`, payload);
      const r2 = await postJson(`${server.baseUrl}/submitHelpIssue`, payload);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(429);
      expect(r2.data).toEqual({ error: 'HELP_AI_ISSUE_LIMIT_REACHED' });
    } finally {
      await server.close();
    }
  });
});
