import { OpenAI } from "openai";
import config from "../config";

let client: OpenAI;

export function openAIClient(): OpenAI {
  if (!config.OPEN_AI_API_KEY) {
    throw new Error("Ask Keeper is not configured");
  }
  if (!client) {
    client = new OpenAI({ apiKey: config.OPEN_AI_API_KEY });
  }
  return client;
}
