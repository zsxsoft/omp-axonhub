/**
 * The persisted gateway location.
 *
 * `/login axonhub` exists so the extension can be configured without
 * environment variables, which means the URL it asks for has to outlive the
 * login. omp keeps the key in `agent.db`; the URL is kept here, in the agent
 * directory it belongs to, and is read back on the next start.
 *
 * Reads are synchronous because the extension factory is, and the file holds a
 * single string. A missing or corrupt file reads as "not configured" rather
 * than failing startup.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE_NAME = "axonhub.json";

interface StoredSettings {
  baseUrl?: string;
}

export function settingsPath(agentDir: string): string {
  return join(agentDir, FILE_NAME);
}

/** The stored gateway URL, or undefined when absent, empty, or unreadable. */
export function readStoredBaseUrl(agentDir: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(settingsPath(agentDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const { baseUrl } = JSON.parse(raw) as StoredSettings;
    return typeof baseUrl === "string" && baseUrl.length > 0 ? baseUrl : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredBaseUrl(agentDir: string, baseUrl: string): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(settingsPath(agentDir), `${JSON.stringify({ baseUrl }, null, 2)}\n`);
}
