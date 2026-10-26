/**
 * Helper functions for effect resolution.
 * Extracted from effects.ts for max-lines compliance.
 */

import { statSync } from "node:fs";
import { invokeHarness } from "../../../invoker";
import type { HarnessInvokeOptions, StreamingOutputOptions } from "../../../types";
import {
  WORKER_TIMEOUT_MS,
  compressInternalHarnessPrompt,
  isInternalHarness,
  promptPiWithRetry,
  type AgentCoreSessionHandle,
  type AskUserQuestionResponse,
  type CompressionConfig,
  type EffectAction,
  type ResolveEffectResult,
} from "../utils";
import { coerceAgentResultValue } from "../planProcess";

export function readProcessFileFingerprint(processPath: string): string | undefined {
  try {
    const stat = statSync(processPath);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

export function isRetryableEffectError(error: unknown): boolean {
  const message = typeof error === "string"
    ? error : error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("timeout") || lower.includes("timed out") ||
    lower.includes("econnreset") || lower.includes("econnrefused") ||
    lower.includes("epipe") || lower.includes("rate limit") ||
    lower.includes("too many requests") || lower.includes("server had an error") ||
    lower.includes("temporarily unavailable") || lower.includes("please retry") ||
    lower.includes("killed") || lower.includes("signal") ||
    lower.includes("already processing") ||
    isUsageLimitError(message)
  );
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When a usage limit says it resets, in this machine's time zone:
 * "resets 4:50am", "resets Oct 27, 3pm" (Claude), "try again at 5:23 PM" (Codex),
 * "try again in 2 hours" or "in 45 minutes". Null when the message names no time.
 */
export function usageLimitResetAt(message: string, now: Date = new Date()): Date | null {
  const relative = message.match(/(?:try again |resets )in (\d+)\s*(minute|min|hour|hr|day)s?/i);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit.startsWith("d") ? 86_400_000 : unit.startsWith("h") ? 3_600_000 : 60_000;
    return new Date(now.getTime() + n * ms);
  }
  const at = message.match(
    /(?:resets|try again at)\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
  );
  if (!at) return null;
  let hour = Number(at[3]) % 12;
  if (at[5].toLowerCase() === "pm") hour += 12;
  const reset = new Date(now);
  reset.setHours(hour, Number(at[4] ?? 0), 0, 0);
  if (at[1]) {
    reset.setMonth(MONTHS.indexOf(at[1].toLowerCase()), Number(at[2]));
    if (reset.getTime() < now.getTime() - 86_400_000) reset.setFullYear(reset.getFullYear() + 1);
  } else if (reset.getTime() <= now.getTime()) {
    reset.setDate(reset.getDate() + 1);
  }
  return reset;
}

/** A subscription usage limit: it resets on a schedule, so it is worth a long wait. */
export function isUsageLimitError(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  return /hit your (session|usage|weekly) limit|usage limit|limit reached/i.test(message);
}

export function buildBreakpointResult(
  response: AskUserQuestionResponse, approvalKey: string,
): ResolveEffectResult {
  const option = response.answers[approvalKey] ?? "Reject";
  return { status: "ok", value: { approved: option === "Approve", option, askUserQuestion: response } };
}

export async function invokePromptEffect(
  action: EffectAction, taskHarness: string, prompt: string,
  options: { workspace?: string; model?: string; compressionConfig?: CompressionConfig | null; streaming?: StreamingOutputOptions },
  piSession?: AgentCoreSessionHandle | null,
): Promise<ResolveEffectResult> {
  if ((isInternalHarness(taskHarness) || taskHarness === "pi") && piSession) {
    const piResult = await promptPiWithRetry({
      session: piSession,
      message: compressInternalHarnessPrompt(prompt, options.compressionConfig, "skill"),
      timeout: WORKER_TIMEOUT_MS, label: `effect ${action.effectId}`,
    });
    return {
      status: piResult.success ? "ok" : "error",
      value: piResult.success ? piResult.output : undefined,
      error: piResult.success ? undefined : new Error(piResult.output),
      stdout: piResult.output,
    };
  }
  const result = await invokeHarness(taskHarness, {
    prompt: compressInternalHarnessPrompt(prompt, options.compressionConfig, "skill"),
    workspace: options.workspace, model: options.model, streaming: options.streaming,
  });
  return {
    status: result.success ? "ok" : "error",
    value: result.success ? result.output : undefined,
    error: result.success ? undefined : new Error(result.output),
    stdout: result.output,
  };
}

type ThinkingEffort = NonNullable<HarnessInvokeOptions["thinkingEffort"]>;
const THINKING_EFFORTS: readonly string[] = ["low", "medium", "high", "max"];

function taskExecution(
  action: EffectAction,
): { model?: string; timeout?: number; thinkingEffort?: ThinkingEffort } {
  const taskDef = action.taskDef as Record<string, unknown> | undefined;
  const execution = taskDef?.execution as Record<string, unknown> | undefined;
  const timeout = execution?.timeoutMs ?? execution?.timeout;
  return {
    model: typeof execution?.model === "string" ? execution.model : undefined,
    timeout: typeof timeout === "number" ? timeout : undefined,
    thinkingEffort: THINKING_EFFORTS.includes(execution?.effort as string)
      ? (execution?.effort as ThinkingEffort)
      : undefined,
  };
}

export async function invokeAgentHarness(
  action: EffectAction, taskHarness: string, prompt: string,
  options: { workspace?: string; model?: string; streaming?: import("../../../types").StreamingOutputOptions },
): Promise<ResolveEffectResult> {
  // A delegated task is one-shot: nonInteractive closes the harness's stdin.
  // The task's own execution.model wins over the run-level model.
  const execution = taskExecution(action);
  const result = await invokeHarness(taskHarness, {
    prompt: compressInternalHarnessPrompt(prompt, null, "agent"),
    workspace: options.workspace,
    model: execution.model ?? options.model,
    timeout: execution.timeout,
    thinkingEffort: execution.thinkingEffort,
    nonInteractive: true,
    streaming: options.streaming,
  });
  return {
    status: result.success ? "ok" : "error",
    value: result.success
      ? coerceAgentResultValue(action.taskDef as unknown as Record<string, unknown>, result.output)
      : undefined,
    error: result.success ? undefined : new Error(result.output),
    stdout: result.output,
  };
}
