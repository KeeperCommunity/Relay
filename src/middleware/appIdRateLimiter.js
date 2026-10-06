const rateLimitConfig = require('../config/rateLimitConfig');

function getLimitForScope(scope) {
  if (scope === "helpIssue") {
    return rateLimitConfig.HELP_ISSUE_LIMIT_PER_DAY;
  }

  if (scope === "chatMessage") {
    return rateLimitConfig.CHAT_MESSAGE_LIMIT;
  }

  return rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY;
}

export function appIdRateLimiter(options = {}) {
  const { scope = 'chat' } = options;
  const shouldCount =
    typeof options.shouldCount === 'function' ? options.shouldCount : () => true;
  const maxRequestsInWindow = getLimitForScope(scope);
  const appIdLimits = new Map(); // In-memory storage for appId limits

  return (req, res, next) => {
    const appId = req.headers['x-app-id'] || req.body?.appId;

    if (!appId) {
      return res.status(400).json({ error: 'Missing appId in request headers' });
    }

    if (!shouldCount(req)) {
      return next();
    }

    const now = Date.now();
    const windowStart = now - 24 * 60 * 60 * 1000; // Rolling 24-hour window

    if (!appIdLimits.has(appId)) {
      appIdLimits.set(appId, []);
    }

    const timestamps = appIdLimits
      .get(appId)
      .filter((timestamp) => timestamp > windowStart);

    if (timestamps.length >= maxRequestsInWindow) {
      // Distinct error codes for frontend handling
      let errorCode = "HELP_AI_RATE_LIMIT_REACHED";
      if (scope === "chat") {
        errorCode = "HELP_AI_NEW_CHAT_LIMIT_REACHED";
      } else if (scope === "chatMessage") {
        errorCode = "HELP_AI_DAILY_MESSAGE_LIMIT_REACHED";
      } else if (scope === "helpIssue") {
        errorCode = "HELP_AI_ISSUE_LIMIT_REACHED";
      }
      return res.status(429).json({ error: errorCode });
    }

    timestamps.push(now);
    appIdLimits.set(appId, timestamps);

    next();
  };
}