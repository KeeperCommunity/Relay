type HelpChatSourceLink = { title: string; url: string };

const HELP_CHAT_ALLOWED_LINK_DOMAINS = [
  "bitcoinkeeper.app",
  "tapsigner.com",
  "coldcard.com",
  "seedsigner.com",
  "specter.solutions",
  "ledger.com",
  "trezor.io",
  "bitbox.swiss",
  "blockstream.com",
  "help.blockstream.com",
  "keyst.one",
  "foundation.xyz",
  "satochip.io",
  "store.coinkite.com",
  "docs.coinkite.com",
  "suite.trezor.io",
  "support.ledger.com",
  "youtube.com",
  "coingecko.com",
  "github.com",
  "en.bitcoin.it",
  "medium.com",
];

const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s<>()\[\]{}"]+/gi;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function isIPv4Host(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isIPv6Host(host: string): boolean {
  return host.includes(":");
}

function isIpLiteralHost(host: string): boolean {
  return isIPv4Host(host) || isIPv6Host(host);
}

function isLocalhostHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

function isAllowlistedHost(host: string): boolean {
  return HELP_CHAT_ALLOWED_LINK_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function logBlockedHelpChatUrl(
  url: string,
  stage: "sources" | "reply",
  reason: string,
): void {
  console.warn("[help-chat-link-blocked]", {
    stage,
    reason,
    url,
  });
}

function isAllowedHelpChatUrl(
  rawUrl: string,
): { allowed: boolean; reason?: string } {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "https:") {
    return { allowed: false, reason: "non_https" };
  }

  const host = normalizeHost(parsed.hostname || "");
  if (!host) {
    return { allowed: false, reason: "missing_host" };
  }

  if (isLocalhostHost(host)) {
    return { allowed: false, reason: "localhost_blocked" };
  }

  if (isIpLiteralHost(host)) {
    return { allowed: false, reason: "ip_host_blocked" };
  }

  if (!isAllowlistedHost(host)) {
    return { allowed: false, reason: "domain_not_allowlisted" };
  }

  return { allowed: true };
}

function splitTrailingPunctuation(token: string): {
  core: string;
  trailing: string;
} {
  const match = token.match(/[.,!?;:)+\]]+$/);
  if (!match) return { core: token, trailing: "" };

  const trailing = match[0];
  return {
    core: token.slice(0, -trailing.length),
    trailing,
  };
}

export function sanitizeReplyLinks(text: string): string {
  if (!text) return text;

  const sanitized = text.replace(URL_IN_TEXT_PATTERN, (token) => {
    const { core, trailing } = splitTrailingPunctuation(token);
    const verdict = isAllowedHelpChatUrl(core);

    if (!verdict.allowed) {
      logBlockedHelpChatUrl(core, "reply", verdict.reason || "blocked");
      return trailing;
    }

    return core + trailing;
  });

  return sanitized.replace(/\s{2,}/g, " ").trim();
}

export function filterAndDedupeSources(
  sources: HelpChatSourceLink[],
  max = 4,
): HelpChatSourceLink[] {
  const unique: HelpChatSourceLink[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (!source?.url) continue;

    const verdict = isAllowedHelpChatUrl(source.url);
    if (!verdict.allowed) {
      logBlockedHelpChatUrl(
        source.url,
        "sources",
        verdict.reason || "blocked",
      );
      continue;
    }

    if (seen.has(source.url)) continue;
    unique.push(source);
    seen.add(source.url);
    if (unique.length >= max) break;
  }

  return unique;
}