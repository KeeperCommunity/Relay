// Centralized configuration for rate limits

const rateLimitConfig = {
  CHAT_CREATION_LIMIT_PER_DAY: 3, // Maximum new chats per appId per day
  CHAT_MESSAGE_LIMIT: 50, // Maximum chat responses per appId per day
  HELP_ISSUE_LIMIT_PER_DAY: 3, // Maximum help issues per appId per day
  IP_RATE_LIMIT_MULTIPLIER: 3, // Multiplier for IP-based rate limits
};

module.exports = rateLimitConfig;