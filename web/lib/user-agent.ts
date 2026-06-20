// Keep the runtime behavior intentionally tolerant: invalid User-Agent values
// show a non-blocking hint in the UI and are ignored by the backend.
import { hasControlChars } from "../../src/user-agent.js";

export const USER_AGENT_PRESETS = [
  { labelKey: "config.userAgentPresetDefault", value: "" },
  { labelKey: "config.userAgentPresetCodexCli", value: "codex-cli" },
  { labelKey: "config.userAgentPresetClaudeCode", value: "claude-cli/2.1.161 (external, cli)" },
  { labelKey: "config.userAgentPresetClaudeCli", value: "claude-cli/2.1.161" },
  { labelKey: "config.userAgentPresetClaudeCodeShort", value: "claude-code/1.0.0" },
  { labelKey: "config.userAgentPresetKiloCode", value: "Kilo-Code/1.0" },
] as const;

export function isValidUserAgentHeader(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  // 控制字符正则与后端单一来源（src/user-agent.ts），避免前后端校验漂移。
  return !hasControlChars(trimmed);
}
