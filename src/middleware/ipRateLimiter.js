const rateLimitConfig = require('../config/rateLimitConfig');

function getLimitForScope(scope) {
  let baseLimit = rateLimitConfig.CHAT_CREATION_LIMIT_PER_DAY;

  if (scope === "helpIssue") {
    baseLimit = rateLimitConfig.HELP_ISSUE_LIMIT_PER_DAY;
  } else if (scope === "chatMessage") {
    baseLimit = rateLimitConfig.CHAT_MESSAGE_LIMIT;
  }

  return baseLimit * rateLimitConfig.IP_RATE_LIMIT_MULTIPLIER;
}

export function ipRateLimiter(options = {}) {
  const { scope = 'chat' } = options;
  const shouldCount =
    typeof options.shouldCount === 'function' ? options.shouldCount : () => true;
  const maxRequestsInWindow = getLimitForScope(scope);
  const ipLimits = new Map(); // In-memory storage for IP limits

  return (req, res, next) => {
    const ip = req.ip;

    if (!ip) {
      return res.status(400).json({ error: 'Unable to determine IP address' });
    }

    if (!shouldCount(req)) {
      return next();
    }

    const now = Date.now();
    const windowStart = now - 24 * 60 * 60 * 1000; // Rolling 24-hour window

    if (!ipLimits.has(ip)) {
      ipLimits.set(ip, []);
    }

    const timestamps = ipLimits.get(ip).filter((timestamp) => timestamp > windowStart);

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
    ipLimits.set(ip, timestamps);

    next();
  };
}