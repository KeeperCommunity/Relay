import { createPrivateKey } from "crypto";

export function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function requiredPrivateKey(name: string): string {
  const value = requiredEnvironmentValue(name).replace(/\\n/g, "\n");
  try {
    createPrivateKey(value);
  } catch (_) {
    // Provider/parser errors may include input. Never return credential contents.
    throw new Error(`Invalid private key in environment variable: ${name}`);
  }
  return value;
}
