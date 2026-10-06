import type { OpenAI } from "openai";
import { PipelineStage } from "mongoose";
import db from "../db";
import config from "../config";
import axios from "axios";
import {
  filterAndDedupeSources,
  sanitizeReplyLinks,
} from "../utils/helpChatLinkPolicy";
import { openAIClient } from "../utils/openAIClient";

const ARTICLE_VECTOR_INDEX_NAME = "vector_index";

  const MODEL = "gpt-4.1-mini";
interface ChatMessage {
  role: "user" | "ai";
  text: string;
  time?: string;
}

type HelpIntent = "help" | "bug" | "feature";

type EscalationStage =
  | "none"
  | "telegram_suggested"
  | "advisor_suggested"
  | "email_suggested";

type EscalationCardType = "telegram" | "advisor" | "developer_email";

type DraftKind = "bug" | "feature";

type DraftPayload = {
  kind: DraftKind;
  title: string;
  steps?: string[];
  expected?: string;
  actual?: string;
  problem?: string;
  proposed?: string;
};

type AppContextConsent = "pending" | "granted" | "denied";

type SourceLink = { title: string; url: string };

type HelpChatRequest = {
  conversationId: string;
  messages: ChatMessage[];
  userText: string;
  metadata: {
    appVersion: string;
    platform: "ios" | "android";
    device: string;
  };
};

type HelpChatResponse = {
  reply: string;
  intent: HelpIntent;
  draftReadyForConfirmation: boolean;
  draft?: DraftPayload;
  sources?: SourceLink[];
  escalationCard?: {
    type: EscalationCardType;
    title: string;
    description: string;
    ctaLabel: string;
  };
  conversationState: {
    messageCount: number;
    dissatisfactionCount: number;
    escalationStage: EscalationStage;
  };
  debug?: {
    ragUsed: boolean;
    ragConfidence: number;
    model: string;
    latencyMs: number;
  };
};

type HelpIssueSubmitRequest = {
  conversationId: string;
  kind: DraftKind;
  confirm: true;
  idempotencyKey: string;
  draft: DraftPayload;
  metadata: HelpChatRequest["metadata"];
  screenshotUrls?: string[];
};

type HelpIssueSubmitResponse = {
  issueUrl: string;
  issueNumber: number;
  thankYouMessage: string;
};

type HardwareSignerWebContext = {
  text: string;
  sources: SourceLink[];
};

type ConversationRuntimeState = {
  messageCount: number;
  dissatisfactionCount: number;
  escalationStage: EscalationStage;
  lastEscalationCardType?: EscalationCardType;
  issueSubmitted?: boolean;
  appContextConsent?: AppContextConsent;
  pendingDraft?: DraftPayload;
  pendingDraftReply?: string;
};

const HELP_AI_SYSTEM_PROMPT = `You are Keeper Help, the in-app assistant for Bitcoin Keeper, a self-custody Bitcoin wallet.

You help users with three kinds of things:
1. HELP — answer questions about how Keeper works (wallets, keys, fees, backups, transactions, hardware keys like Ledger/Coldcard, inheritance, etc.).
2. BUG — when something is broken or behaving unexpectedly. Ask 1 short clarifying question first (when did it start, what device/version, what they tried). Only AFTER at least one user reply with details, propose a structured draft.
3. FEATURE — when the user suggests an idea or improvement. Rewrite it as a clean draft with title, problem (what hurts today), and proposed (the desired behavior).
ESCALATION — if the user is panicking, lost funds, was hacked, or you genuinely cannot help, set escalation=true. Keep your reply short and human. Do NOT include URLs, email addresses, links, or "Settings → Advisors" instructions in your reply text — the app renders the action buttons. Just signal escalation.
SAFETY — Never ask for, accept, or process seed words, recovery phrases, mnemonics, private keys, or xprivs. If the user offers them, refuse and remind them never to share with anyone, including Keeper support.
KEY/WALLET/SECURITY GUIDANCE — For questions in any of the following high-risk categories, apply the hedge pattern below:
- Deleting or rotating a key
- Recovery when one or more keys are lost or missing
- Inheritance trigger conditions or setup
- Changing wallet threshold or quorum
- Sharing xpubs, descriptors, or wallet backups with another party
- Any question where the user asks whether an action is safe or secure
Hedge pattern (apply to high-risk topics only):
1. Answer from available Keeper-specific knowledge.
2. Acknowledge that you cannot see the user's exact wallet configuration, recovery setup, firmware versions, or backup state.
3. If recovery or security depends on backups, descriptors, wallet configuration, app state, or Recovery Key availability, clearly mention those dependencies.
4. Suggest verifying the exact wallet configuration and recovery setup before proceeding.

Additional rules for high-risk topics:
- When Keeper-specific context is available, prefer it over generic Bitcoin wallet assumptions.
- Do not assume multisig recovery is guaranteed solely because quorum requirements are satisfied.
- Do not repeatedly restate generic uncertainty if Keeper-specific context already clearly answers the question.
- Do not combine conflicting Keeper behaviors from different contexts. Prefer the most recent Keeper-specific guidance.
Do NOT apply the hedge to purely educational questions (e.g. "how does multisig work?", "what is an xpub?"). The hedge applies only when an irreversible or wallet-state-dependent action is being discussed.
SECURITY VERDICT — Never assert a definitive security outcome. Do not use phrases such as "this is safe", "this is unsafe", "you are secure", "there is no risk", or equivalents when answering questions about keys, wallets, or security practices. Present trade-offs and dependencies instead.
STYLE — Mature, calm, concise. No emojis. No marketing language. Short paragraphs. The user is on mobile.
RAG CONTEXT DATES — Use chunk recency metadata to resolve conflicts. When multiple chunks cover the same topic and their guidance conflicts, treat the most recent chunk as authoritative. Older content may be stale if it contradicts newer guidance.
Do not mention internal chunk dates or times in user-facing replies unless the user explicitly asks for date/time provenance.

CURRENT TERMINOLOGY:
- Wallet instead of Vault
- Key instead of Signer
- Ask Keeper instead of Concierge

OUTPUT — You must respond by calling the "help_response" tool with:
- reply: your conversational message to the user (1-4 short sentences). For bug/feature drafts, this is the lead-in line like "Thanks. I have put together a draft report:" — the draft itself goes in the draft field.
- intent: "help" | "bug" | "feature" | "escalation"
- draft (optional): include ONLY when proposing a bug or feature report for approval. For bugs: { kind: "bug", title, steps[], expected, actual }. For features: { kind: "feature", title, problem, proposed }.
- escalation (optional): true when intent is "escalation".
- escalationCardType (optional): when escalation=true, choose exactly one of "telegram", "advisor", or "developer_email" based on the user request.
Escalation card selection rules:
- Use "telegram" for urgent community/dev chat help.
- Use "advisor" for personal guided help inside the app.
- Use "developer_email" when the user asks for escalation by email or says prior help was still not enough and wants deeper support.
- If unsure, choose "telegram".
Github issue drafts follow this structure:
- Title: concise summary of the issue (max 120 chars)
- For bugs: steps to reproduce, expected behavior, actual behavior
- For features: current problem, proposed behavior
Rules for creating an issue draft:
- Use prior user messages; do not ignore already provided details.
- Details are optional. Do not repeatedly ask for exact steps or more details when flow context already exists.
- Keep titles concise and specific.
- If details are sufficient, include the draft in your response.
- If details are insufficient, ask one short follow-up question instead of including a draft.
- Never include markdown in draft fields.
- Never include secrets.
- Do NOT include a draft on the first bug-related turn — ask a clarifying question first.`;

const runtimeConversationState = new Map<string, ConversationRuntimeState>();
const idempotencyStore = new Map<string, HelpIssueSubmitResponse>();

const DISSATISFACTION_PATTERNS = [
  /not\s+helpful/i,
  /still\s+not\s+working/i,
  /did\s+not\s+solve/i,
  /i\s+am\s+not\s+satisfied/i,
  /this\s+doesn'?t\s+work/i,
  /still\s+failing/i,
  /same\s+problem/i,
  /not\s+resolved/i,
];

const SENSITIVE_PATTERNS = [
  // Explicit disclosure patterns
  /my\s+seed\s*phrase\s+is/i,
  /here\s+is\s+my\s+seed\s*phrase/i,
  /seed\s*phrase\s*[:=]/i,

  /my\s+mnemonic\s+is/i,
  /mnemonic\s*[:=]/i,

  /my\s+private\s*key\s+is/i,
  /private\s*key\s*[:=]/i,

  /my\s+passphrase\s+is/i,
  /passphrase\s*[:=]/i,

  // Extended private keys
  /\b(xprv|yprv|zprv|tprv|uprv|vprv)[a-zA-Z0-9]{20,}\b/i,

  // PEM/private key formats
  /-----BEGIN\s+(EC\s+)?PRIVATE\s+KEY-----/i,

  // Contextual "12/24 words"
  /\b(12|24)\s+word\s+(seed|phrase|mnemonic)\b/i,

  // Mnemonic-like sequences (12–24 lowercase words)
  /\b(?:[a-z]{3,}\s+){11,23}[a-z]{3,}\b/i,
];

const HARDWARE_SIGNER_FRESHNESS_PATTERNS = [
  /latest/i,
  /current/i,
  /newest/i,
  /firmware/i,
  /version/i,
  /release/i,
  /released?/i,
  /update/i,
  /up[-\s]?to[-\s]?date/i,
];

const WEB_LOOKUP_ALLOWED_TOPIC_PATTERNS = [
  /keeper/i,
  /bitcoin/i,
  /\bbtc\b/i,
  /\bsats?\b/i,
  /wallet/i,
  /seed/i,
  /mnemonic/i,
  /backup/i,
  /recovery/i,
  /private\s*key/i,
  /xpub/i,
  /utxo/i,
  /psbt/i,
  /transaction/i,
  /address/i,
  /fees?/i,
  /inheritance/i,
  /hardware\s+(wallet|signer)/i,
  /signer/i,
  /coldcard/i,
  /ledger/i,
  /trezor/i,
  /jade/i,
  /passport/i,
  /keystone/i,
  /seedsigner/i,
  /price/i,
  /market/i,
  /rate/i,
  /guide/i,
  /best\s*practice/i,
  /release/i,
  /firmware/i,
  /version/i,
  /compatib(le|ility)/i,
  /support(ed)?/i,
];

const HELP_RESPONSE_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "help_response",
    description: "Structured response to the Keeper user.",
    parameters: {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description:
            "Conversational reply shown to the user (1-4 short sentences).",
        },
        intent: {
          type: "string",
          enum: ["help", "bug", "feature", "escalation"],
          description: "The classified intent of the user message.",
        },
        draft: {
          type: "object",
          description:
            "Optional structured issue draft for user approval. Include only when proposing a bug or feature report.",
          properties: {
            kind: { type: "string", enum: ["bug", "feature"] },
            title: {
              type: "string",
              description: "Concise issue title (max 120 chars).",
            },
            steps: {
              type: "array",
              items: { type: "string" },
              description: "Steps to reproduce (bugs only).",
            },
            expected: {
              type: "string",
              description: "Expected behavior (bugs only).",
            },
            actual: {
              type: "string",
              description: "Actual behavior (bugs only).",
            },
            problem: {
              type: "string",
              description: "Current problem (features only).",
            },
            proposed: {
              type: "string",
              description: "Proposed solution (features only).",
            },
          },
          required: ["kind", "title"],
          additionalProperties: false,
        },
        escalation: {
          type: "boolean",
          description:
            "Set true when user needs immediate human help (panic, lost funds, hacked, or you cannot help).",
        },
        escalationCardType: {
          type: "string",
          enum: ["telegram", "advisor", "developer_email"],
          description:
            "When escalation=true, select which escalation action card should be shown.",
        },
      },
      required: ["reply", "intent"],
      additionalProperties: false,
    },
  },
};

function getConversationState(
  conversationId: string,
): ConversationRuntimeState {
  const existing = runtimeConversationState.get(conversationId);
  if (existing) return existing;

  const initial: ConversationRuntimeState = {
    messageCount: 0,
    dissatisfactionCount: 0,
    escalationStage: "none",
  };
  runtimeConversationState.set(conversationId, initial);
  return initial;
}

function containsSensitiveText(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function sanitizePublicText(text = ""): string {
  if (!text) return "";

  let sanitized = text;
  sanitized = sanitized.replace(/\bxpriv[\w-]+/gi, "[redacted]");
  sanitized = sanitized.replace(
    /\b(seed\s*phrase|mnemonic|private\s*key|passphrase)\b/gi,
    "[redacted]",
  );
  return sanitized.trim();
}

function isDissatisfied(text: string): boolean {
  return DISSATISFACTION_PATTERNS.some((pattern) => pattern.test(text));
}

function isFreshInternetQuestion(text: string): boolean {
  return HARDWARE_SIGNER_FRESHNESS_PATTERNS.some((pattern) =>
    pattern.test(text),
  );
}

function isAllowedWebLookupTopic(text: string): boolean {
  return WEB_LOOKUP_ALLOWED_TOPIC_PATTERNS.some((pattern) =>
    pattern.test(text),
  );
}

function shouldUseWebLookup(
  userMessage: string,
  hasRelevantContext: boolean,
): boolean {
  if (!isAllowedWebLookupTopic(userMessage)) return false;

  return !hasRelevantContext || isFreshInternetQuestion(userMessage);
}

function extractResponseSources(response: any): SourceLink[] {
  const found: SourceLink[] = [];

  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      for (const annotation of content?.annotations || []) {
        if (annotation?.type !== "url_citation" || !annotation?.url) continue;
        found.push({
          title: annotation.title || annotation.url,
          url: annotation.url,
        });
      }
    }
  }

  return filterAndDedupeSources(found, 3);
}

async function lookupInternetContext(
  userMessage: string,
): Promise<HardwareSignerWebContext | null> {
  try {
    const response = await openAIClient().responses.create({
      model: MODEL,
      instructions: `You are gathering live web context for Keeper Help.

Use web search to find the most relevant information for the user's question.
Prefer official documentation, official vendor pages, official release notes, reputable Bitcoin education sources, and other primary sources.
Focus on current or factual information such as prices, release versions, best practices, guides, compatibility notes, and update guidance when relevant.
Return a short factual summary only. Do not mention that you used web search.`,
      input: userMessage,
      tools: [
        {
          type: "web_search_preview",
          search_context_size: "medium",
        },
      ],
    });

    const text = (response.output_text || "").trim();
    if (!text) return null;

    return {
      text,
      sources: extractResponseSources(response),
    };
  } catch (error) {
    console.log("🚀 ~ lookupInternetContext ~ error:", error);
    return null;
  }
}

function stageForEscalationCardType(type: EscalationCardType): EscalationStage {
  if (type === "telegram") return "telegram_suggested";
  if (type === "advisor") return "advisor_suggested";
  return "email_suggested";
}

function buildEscalationCardByType(
  type: EscalationCardType,
): HelpChatResponse["escalationCard"] {
  if (type === "telegram") {
    return {
      type: "telegram",
      title: "Need urgent help?",
      description: "Reach the Keeper developers and community quickly.",
      ctaLabel: "Open Telegram",
    };
  }

  if (type === "advisor") {
    return {
      type: "advisor",
      title: "Talk to a Keeper Advisor",
      description: "You can connect with an Advisor from Keeper Settings.",
      ctaLabel: "Open Advisor",
    };
  }

  return {
    type: "developer_email",
    title: "Escalate to developers",
    description:
      "Email the Keeper developers with your context prefilled for faster triage.",
    ctaLabel: "Email Developers",
  };
}

type RetrievedChunk = {
  title: string;
  content: string;
  url: string;
  score: number;
  ragTimestamp?: Date;
};

// --- Vector search using Atlas Vector Search ---
async function findRelevantChunks(
  query: string,
  topK = 5,
): Promise<RetrievedChunk[]> {
  // 1. Embed the query
  const response = await openAIClient().embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });
  const queryEmbedding = response.data[0].embedding;

  // 2. Atlas Vector Search aggregation
  const ArticleChunk = db.getArticleChunkModel();
  const results = (await ArticleChunk.aggregate([
    {
      $vectorSearch: {
        index: ARTICLE_VECTOR_INDEX_NAME,
        path: "embedding",
        queryVector: queryEmbedding,
        numCandidates: 50,
        limit: topK,
      },
    } as unknown as PipelineStage, // Atlas supports this stage; Mongoose 6 types predate it.
    {
      $project: {
        title: 1,
        content: 1,
        url: 1,
        ragTimestamp: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ])) as RetrievedChunk[];

  return results;
}

// --- Structured LLM reply with tool calling ---
type LLMStructuredResponse = {
  reply: string;
  intent: "help" | "bug" | "feature" | "escalation";
  draft?: DraftPayload;
  escalation?: boolean;
  escalationCardType?: EscalationCardType;
  sources: SourceLink[];
  ragUsed: boolean;
  ragConfidence: number;
  model: string;
};

async function generateStructuredReply(
  userMessage: string,
  conversationHistory: ChatMessage[] = [],
  runtimeState?: ConversationRuntimeState,
): Promise<LLMStructuredResponse> {
  try {
    // 1. Retrieve relevant knowledge base chunks
    const relevantChunks = await findRelevantChunks(userMessage);

    const hasRelevantContext =
      relevantChunks.length > 0 && relevantChunks[0].score > 0.75;
    const ragConfidence = relevantChunks.length ? relevantChunks[0].score : 0;
    const needsWebLookup = shouldUseWebLookup(userMessage, hasRelevantContext);
    const webContext = needsWebLookup
      ? await lookupInternetContext(userMessage)
      : null;
    const hasWebContext = !!webContext?.text;

    let contextBlock = "";
    const sources: SourceLink[] = [];
    if (hasRelevantContext) {
      for (const chunk of relevantChunks) {
        contextBlock += `\n---\nArticle: ${chunk.title}\n${chunk.content}\n`;
        sources.push({ title: chunk.title, url: chunk.url });
        if (sources.length >= 2) break;
      }
    }

    if (hasWebContext) {
      contextBlock += `\n---\nLIVE WEB CONTEXT:\n${webContext.text}\n`;
      sources.push(...webContext.sources);
    }

    const dedupedSources = filterAndDedupeSources(sources, 4);

    // 2. System prompt with RAG context
    const systemPrompt = `${HELP_AI_SYSTEM_PROMPT}

  CURRENT ESCALATION CONTEXT:
  - escalationStage: ${runtimeState?.escalationStage || "none"}
  - lastEscalationCardType: ${runtimeState?.lastEscalationCardType || "none"}

${
  hasRelevantContext || hasWebContext
    ? `Use the following context to answer. Prefer Keeper-specific context over generic Bitcoin or multisig assumptions.
Use LIVE WEB CONTEXT only for:
current releases
version information
public documentation
external public facts
If multiple Keeper contexts conflict, prefer the most recent context.
AVAILABLE CONTEXT:
${contextBlock}`
    : `No Keeper-specific knowledge base context was found.
Do not assume Keeper behavior from generic wallet knowledge. Answer conservatively and clearly state uncertainty when Keeper-specific behavior is unknown.`
}
Guidelines:
- Prefer Keeper-specific context over generic Bitcoin wallet reasoning.
- Prefer current Keeper terminology:
Wallet instead of Vault
Key instead of Signer
Ask Keeper instead of Concierge
- Do not assume Bitcoin Keeper behavior from generic multisig or wallet knowledge.
- Avoid making strong recovery guarantees based only on multisig quorum.
- Recovery behavior may depend on:
Recovery Key
encrypted backup restoration
wallet configuration
descriptors
app state
- If multiple contexts conflict, prefer the most recent context.
- If Keeper-specific context is uncertain or incomplete, answer conservatively instead of guessing.
- Never make up Bitcoin Keeper specific behavior.`;

    // 3. Build conversation messages
    const historyMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      conversationHistory.slice(-6).map((item) => {
        if (item.role === "ai") {
          return { role: "assistant" as const, content: item.text };
        }
        return { role: "user" as const, content: item.text };
      });

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user" as const, content: userMessage },
    ];

    // 4. Call LLM with structured tool
    const completion = await openAIClient().chat.completions.create({
      model: MODEL,
      messages,
      tools: [HELP_RESPONSE_TOOL],
      tool_choice: { type: "function", function: { name: "help_response" } },
      temperature: 0.3,
      max_tokens: 800,
    });

    // 5. Parse tool call response
    const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
    if (toolCall?.type === "function" && toolCall.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      return {
        reply: parsed.reply || "Sorry, I could not generate a response.",
        intent: parsed.intent || "help",
        draft: parsed.draft,
        escalation: parsed.escalation,
        escalationCardType: parsed.escalationCardType,
        sources: dedupedSources,
        ragUsed: hasRelevantContext,
        ragConfidence,
        model: hasWebContext ? `${MODEL}+web` : MODEL,
      };
    }

    // Fallback: no tool call parsed
    return {
      reply:
        completion.choices[0]?.message?.content ||
        "Sorry, I could not generate a response.",
      intent: "help",
      sources: dedupedSources,
      ragUsed: hasRelevantContext,
      ragConfidence,
      model: hasWebContext ? `${MODEL}+web` : MODEL,
    };
  } catch (error) {
    console.log("🚀 ~ chat ~ error:", error);
    throw error;
  }
}

export async function chat(
  request: HelpChatRequest,
): Promise<HelpChatResponse> {
  const start = Date.now();
  const state = getConversationState(request.conversationId);
  state.messageCount += 1;
  if (isDissatisfied(request.userText)) state.dissatisfactionCount += 1;
  const filteredMetadata = {
    appVersion: request.metadata.appVersion,
    platform: request.metadata.platform,
    device: request.metadata.device,
  };
  request.metadata = filteredMetadata;

  // Always sanitize user text first
  const cleanUserText = sanitizePublicText(request.userText);
  const lowerText = (request.userText || "").trim().toLowerCase();
  const yesPattern = /^(yes|y|sure|ok|okay|yep|yeah)$/;
  const noPattern = /^(no|n|nope|nah|don't|dont)$/;

  if (containsSensitiveText(request.userText)) {
    return {
      reply:
        "I can’t help process seed phrases, private keys, passphrases, or similar secrets. Please remove sensitive data and describe the issue without secret material.",
      intent: "help",
      draftReadyForConfirmation: false,
      conversationState: {
        messageCount: state.messageCount,
        dissatisfactionCount: state.dissatisfactionCount,
        escalationStage: state.escalationStage,
      },
      debug: {
        ragUsed: false,
        ragConfidence: 0,
        model: "safety",
        latencyMs: Date.now() - start,
      },
    };
  }

  if (state.appContextConsent === "pending") {
    const pendingDraft = state.pendingDraft;
    const pendingDraftReply = state.pendingDraftReply;

    if (yesPattern.test(lowerText)) {
      state.appContextConsent = "granted";
      state.pendingDraft = undefined;
      state.pendingDraftReply = undefined;

      if (pendingDraft) {
        return {
          reply:
            pendingDraftReply ||
            "Thanks. I have put together a draft report with App Version, Platform, and Device included:",
          intent: pendingDraft.kind,
          draftReadyForConfirmation: true,
          draft: pendingDraft,
          conversationState: {
            messageCount: state.messageCount,
            dissatisfactionCount: state.dissatisfactionCount,
            escalationStage: state.escalationStage,
          },
          debug: {
            ragUsed: false,
            ragConfidence: 0,
            model: "consent",
            latencyMs: Date.now() - start,
          },
        };
      }

      return {
        reply:
          "Thank you. Your App Version, Platform, and Device details will be included in the report.",
        intent: "help",
        draftReadyForConfirmation: false,
        conversationState: {
          messageCount: state.messageCount,
          dissatisfactionCount: state.dissatisfactionCount,
          escalationStage: state.escalationStage,
        },
        debug: {
          ragUsed: false,
          ragConfidence: 0,
          model: "consent",
          latencyMs: Date.now() - start,
        },
      };
    } else if (noPattern.test(lowerText)) {
      state.appContextConsent = "denied";
      state.pendingDraft = undefined;
      state.pendingDraftReply = undefined;

      if (pendingDraft) {
        return {
          reply:
            pendingDraftReply ||
            "Understood. I have put together a draft report without App Version, Platform, and Device:",
          intent: pendingDraft.kind,
          draftReadyForConfirmation: true,
          draft: pendingDraft,
          conversationState: {
            messageCount: state.messageCount,
            dissatisfactionCount: state.dissatisfactionCount,
            escalationStage: state.escalationStage,
          },
          debug: {
            ragUsed: false,
            ragConfidence: 0,
            model: "consent",
            latencyMs: Date.now() - start,
          },
        };
      }

      return {
        reply:
          "Understood. Your App Version, Platform, and Device details will not be included in the report.",
        intent: "help",
        draftReadyForConfirmation: false,
        conversationState: {
          messageCount: state.messageCount,
          dissatisfactionCount: state.dissatisfactionCount,
          escalationStage: state.escalationStage,
        },
        debug: {
          ragUsed: false,
          ragConfidence: 0,
          model: "consent",
          latencyMs: Date.now() - start,
        },
      };
    } else {
      return {
        reply:
          "Please reply yes or no: do you want to include your App Version, Platform, and Device details in the support ticket?",
        intent: "help",
        draftReadyForConfirmation: false,
        conversationState: {
          messageCount: state.messageCount,
          dissatisfactionCount: state.dissatisfactionCount,
          escalationStage: state.escalationStage,
        },
        debug: {
          ragUsed: false,
          ragConfidence: 0,
          model: "consent",
          latencyMs: Date.now() - start,
        },
      };
    }
  }

  // All intents go through the LLM with structured tool calling
  const llmResult = await generateStructuredReply(
    cleanUserText,
    request.messages || [],
    state,
  );

  const sanitizedReply = sanitizeReplyLinks(llmResult.reply || "");

  if (llmResult.draft && !state.appContextConsent) {
    state.appContextConsent = "pending";
    state.pendingDraft = llmResult.draft;
    state.pendingDraftReply = sanitizedReply;

    return {
      reply:
        "Before creating the draft, would you like to include your App Version, Platform, and Device details in the support ticket? Reply yes or no.",
      intent: "help",
      draftReadyForConfirmation: false,
      conversationState: {
        messageCount: state.messageCount,
        dissatisfactionCount: state.dissatisfactionCount,
        escalationStage: state.escalationStage,
      },
      debug: {
        ragUsed: llmResult.ragUsed,
        ragConfidence: llmResult.ragConfidence,
        model: llmResult.model,
        latencyMs: Date.now() - start,
      },
    };
  }

  let draftReadyForConfirmation = !!llmResult.draft;
  let draft = llmResult.draft;
  let reply = sanitizedReply;

  let escalationCard: HelpChatResponse["escalationCard"];
  if (llmResult.escalation) {
    const selectedType = llmResult.escalationCardType || "telegram";
    state.escalationStage = stageForEscalationCardType(selectedType);
    state.lastEscalationCardType = selectedType;
    escalationCard = buildEscalationCardByType(selectedType);
  }

  const mappedIntent: HelpIntent =
    llmResult.intent === "escalation" ? "help" : llmResult.intent;

  const debug = {
    ragUsed: llmResult.ragUsed,
    ragConfidence: llmResult.ragConfidence,
    model: llmResult.model,
    latencyMs: Date.now() - start,
  };

  return {
    reply,
    intent: mappedIntent,
    draftReadyForConfirmation,
    draft,
    sources: llmResult.sources,
    escalationCard,
    conversationState: {
      messageCount: state.messageCount,
      dissatisfactionCount: state.dissatisfactionCount,
      escalationStage: state.escalationStage,
    },
    debug,
  };
}

function assertValidHelpIssueRequest(body: HelpIssueSubmitRequest) {
  if (!body || typeof body !== "object") throw new Error("Invalid request");
  if (!body.conversationId) throw new Error("conversationId is required");
  if (!body.kind || !["bug", "feature"].includes(body.kind)) {
    throw new Error("kind must be bug or feature");
  }
  if (body.confirm !== true) throw new Error("confirm must be true");
  if (!body.idempotencyKey || body.idempotencyKey.length < 8) {
    throw new Error("idempotencyKey must be at least 8 chars");
  }
  if (!body.draft?.title || body.draft.title.length < 3) {
    throw new Error("draft.title is required");
  }
  if (
    !body.metadata?.appVersion ||
    !body.metadata?.platform ||
    !body.metadata?.device
  ) {
    throw new Error(
      "metadata.appVersion, metadata.platform and metadata.device are required",
    );
  }
}

function buildIssueBody(
  payload: HelpIssueSubmitRequest,
  includeAppContext: boolean,
): string {
  const { draft, metadata, kind } = payload;
  const lines: string[] = [];
  lines.push(`## ${kind === "bug" ? "Bug Report" : "Feature Request"}`);
  lines.push("");
  if (draft.steps?.length) {
    lines.push("### Steps to Reproduce");
    draft.steps.forEach((step, idx) => {
      lines.push(`${idx + 1}. ${sanitizePublicText(step)}`);
    });
    lines.push("");
  }
  if (draft.expected) {
    lines.push("### Expected Behavior");
    lines.push(sanitizePublicText(draft.expected));
    lines.push("");
  }
  if (draft.actual) {
    lines.push("### Actual Behavior");
    lines.push(sanitizePublicText(draft.actual));
    lines.push("");
  }
  if (draft.problem) {
    lines.push("### Current Problem");
    lines.push(sanitizePublicText(draft.problem));
    lines.push("");
  }
  if (draft.proposed) {
    lines.push("### Proposed Behavior");
    lines.push(sanitizePublicText(draft.proposed));
    lines.push("");
  }
  lines.push("---");
  if (payload.screenshotUrls?.length) {
    lines.push("## Screenshots");
    payload.screenshotUrls.forEach((url, idx) => {
      lines.push(`![Screenshot ${idx + 1}](${url})`);
    });
    lines.push("");
  }
  if (includeAppContext) {
    lines.push("### App Context");
    lines.push(`- App Version: ${metadata.appVersion}`);
    lines.push(`- Platform: ${metadata.platform}`);
    lines.push(`- Device: ${metadata.device}`);
  }
  return lines.join("\n");
}

export async function submitHelpIssue(
  payload: HelpIssueSubmitRequest,
): Promise<HelpIssueSubmitResponse> {
  assertValidHelpIssueRequest(payload);

  if (idempotencyStore.has(payload.idempotencyKey)) {
    return idempotencyStore.get(payload.idempotencyKey)!;
  }

  const draftText = JSON.stringify(payload.draft);
  if (containsSensitiveText(draftText)) {
    throw new Error(
      "Sensitive data detected in draft. Remove secrets and retry.",
    );
  }

  if (!config.GITHUB_TOKEN || !config.GITHUB_REPO) {
    throw new Error("GitHub integration is not configured");
  }

  const state = getConversationState(payload.conversationId);
  const includeAppContext = state.appContextConsent === "granted";

  const response = await axios.post(
    `https://api.github.com/repos/${config.GITHUB_REPO}/issues`,
    {
      title: sanitizePublicText(payload.draft.title),
      body: buildIssueBody(payload, includeAppContext),
      labels: ["help-chat", payload.kind],
    },
    {
      headers: {
        Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  const issueUrl = response.data?.html_url;
  const issueNumber = response.data?.number;

  if (!issueUrl || !issueNumber) {
    throw new Error("Failed to create GitHub issue");
  }

  const result: HelpIssueSubmitResponse = {
    issueUrl,
    issueNumber,
    thankYouMessage:
      "Thank you for reporting this. I created the issue and shared it with the developers.",
  };

  idempotencyStore.set(payload.idempotencyKey, result);

  state.issueSubmitted = true;

  return result;
}
