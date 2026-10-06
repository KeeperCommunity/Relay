import { appIdRateLimiter } from '../../middleware/appIdRateLimiter';
import { ipRateLimiter } from '../../middleware/ipRateLimiter';

const rateLimitConfig = require('../../config/rateLimitConfig');

type MockReq = {
  headers?: Record<string, any>;
  body?: Record<string, any>;
  ip?: string;
};

type MockRes = {
  statusCode?: number;
  payload?: any;
  status: jest.Mock;
  json: jest.Mock;
};

const makeRes = (): MockRes => {
  const res: Partial<MockRes> = {};
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn().mockImplementation((payload: any) => {
    res.payload = payload;
    return res;
  });
  return res as MockRes;
};

describe('appIdRateLimiter unit', () => {
  const originalChatLimit = rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY;
  const originalMessageLimit = rateLimitConfig.CHAT_MESSAGE_LIMIT;

  beforeEach(() => {
    rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY = 2;
    rateLimitConfig.CHAT_MESSAGE_LIMIT = 3;
  });

  afterAll(() => {
    rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY = originalChatLimit;
    rateLimitConfig.CHAT_MESSAGE_LIMIT = originalMessageLimit;
  });

  it('returns 400 when appId is missing', () => {
    const limiter = appIdRateLimiter({ scope: 'chat' });
    const req: MockReq = { headers: {}, body: {} };
    const res = makeRes();
    const next = jest.fn();

    limiter(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing appId in request headers' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows requests until the configured limit and then returns 429', () => {
    const limiter = appIdRateLimiter({ scope: 'chat' });
    const req: MockReq = { headers: { 'x-app-id': 'app-1' }, body: {} };
    const next = jest.fn();

    const res1 = makeRes();
    limiter(req as any, res1 as any, next);

    const res2 = makeRes();
    limiter(req as any, res2 as any, next);

    const res3 = makeRes();
    limiter(req as any, res3 as any, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res3.status).toHaveBeenCalledWith(429);
    expect(res3.json).toHaveBeenCalledWith({ error: 'HELP_AI_NEW_CHAT_LIMIT_REACHED' });
  });

  it("does not consume quota when shouldCount returns false", () => {
    const limiter = appIdRateLimiter({
      scope: "chat",
      shouldCount: (req) => Boolean(req.body?.isNewChat),
    });
    const next = jest.fn();

    const existingReq: MockReq = {
      headers: { "x-app-id": "app-skip" },
      body: { isNewChat: false },
    };
    limiter(existingReq as any, makeRes() as any, next);
    limiter(existingReq as any, makeRes() as any, next);

    const newReq: MockReq = {
      headers: { "x-app-id": "app-skip" },
      body: { isNewChat: true },
    };
    limiter(newReq as any, makeRes() as any, next);
    limiter(newReq as any, makeRes() as any, next);

    const blocked = makeRes();
    limiter(newReq as any, blocked as any, next);

    expect(blocked.status).toHaveBeenCalledWith(429);
  });

  it("uses CHAT_MESSAGE_LIMIT for chatMessage scope", () => {
    const limiter = appIdRateLimiter({ scope: "chatMessage" });
    const req: MockReq = {
      headers: { "x-app-id": "app-message-scope" },
      body: {},
    };
    const next = jest.fn();

    limiter(req as any, makeRes() as any, next);
    limiter(req as any, makeRes() as any, next);
    limiter(req as any, makeRes() as any, next);

    const blocked = makeRes();
    limiter(req as any, blocked as any, next);

    expect(next).toHaveBeenCalledTimes(3);
    expect(blocked.status).toHaveBeenCalledWith(429);
  });
});

describe('ipRateLimiter unit', () => {
  const originalChatLimit = rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY;
  const originalMessageLimit = rateLimitConfig.CHAT_MESSAGE_LIMIT;
  const originalMultiplier = rateLimitConfig.IP_RATE_LIMIT_MULTIPLIER;

  beforeEach(() => {
    rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY = 1;
    rateLimitConfig.CHAT_MESSAGE_LIMIT = 2;
    rateLimitConfig.IP_RATE_LIMIT_MULTIPLIER = 2;
  });

  afterAll(() => {
    rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY = originalChatLimit;
    rateLimitConfig.CHAT_MESSAGE_LIMIT = originalMessageLimit;
    rateLimitConfig.IP_RATE_LIMIT_MULTIPLIER = originalMultiplier;
  });

  it('returns 400 when ip is missing', () => {
    const limiter = ipRateLimiter({ scope: 'chat' });
    const req: MockReq = { ip: undefined };
    const res = makeRes();
    const next = jest.fn();

    limiter(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unable to determine IP address' });
    expect(next).not.toHaveBeenCalled();
  });

  it('uses ip-based quota and returns 429 after limit is exceeded', () => {
    const limiter = ipRateLimiter({ scope: 'chat' });
    const req: MockReq = { ip: '127.0.0.1' };
    const next = jest.fn();

    const res1 = makeRes();
    limiter(req as any, res1 as any, next);

    const res2 = makeRes();
    limiter(req as any, res2 as any, next);

    const res3 = makeRes();
    limiter(req as any, res3 as any, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res3.status).toHaveBeenCalledWith(429);
    expect(res3.json).toHaveBeenCalledWith({ error: 'HELP_AI_NEW_CHAT_LIMIT_REACHED' });
  });

  it("does not consume ip quota when shouldCount returns false", () => {
    const limiter = ipRateLimiter({
      scope: "chat",
      shouldCount: (req) => Boolean(req.body?.isNewChat),
    });
    const next = jest.fn();

    const existingReq: MockReq = {
      ip: "127.0.0.2",
      body: { isNewChat: false },
    };
    limiter(existingReq as any, makeRes() as any, next);
    limiter(existingReq as any, makeRes() as any, next);

    const newReq: MockReq = { ip: "127.0.0.2", body: { isNewChat: true } };
    limiter(newReq as any, makeRes() as any, next);
    limiter(newReq as any, makeRes() as any, next);

    const blocked = makeRes();
    limiter(newReq as any, blocked as any, next);

    expect(blocked.status).toHaveBeenCalledWith(429);
  });

  it("uses CHAT_MESSAGE_LIMIT with IP multiplier for chatMessage scope", () => {
    const limiter = ipRateLimiter({ scope: "chatMessage" });
    const req: MockReq = { ip: "127.0.0.3", body: {} };
    const next = jest.fn();

    limiter(req as any, makeRes() as any, next);
    limiter(req as any, makeRes() as any, next);
    limiter(req as any, makeRes() as any, next);
    limiter(req as any, makeRes() as any, next);

    const blocked = makeRes();
    limiter(req as any, blocked as any, next);

    expect(next).toHaveBeenCalledTimes(4);
    expect(blocked.status).toHaveBeenCalledWith(429);
  });
});
