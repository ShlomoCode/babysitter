import { describe, expect, it } from "vitest";
import { isRetryableEffectError, isUsageLimitError, usageLimitResetAt } from "./effectsHelpers";
import {
  getHookDecisionResult,
  resolveHookDecisionResult,
} from "./hookDecisionEffects";

function action(overrides: Record<string, unknown> = {}) {
  return {
    kind: "shell",
    effectId: "effect-1",
    taskId: "task-1",
    taskDef: {
      title: "Run a command",
      metadata: {},
    },
    ...overrides,
  } as any;
}

describe("hook decision effect helpers", () => {
  it("extracts hook decisions from task metadata", () => {
    const result = getHookDecisionResult(action({
      taskDef: {
        metadata: {
          hookResult: { decision: "block", reason: "policy" },
        },
      },
    }));

    expect(result).toEqual({ decision: "block", reason: "policy" });
  });

  it("turns block decisions into auditable non-approval results", () => {
    const result = resolveHookDecisionResult(
      action(),
      { decision: "block", reason: "sensitive command" },
    );

    expect(result).toMatchObject({
      status: "error",
      value: {
        blocked: true,
        reason: "sensitive command",
        auditEvent: {
          kind: "hook-decision",
          decision: {
            action: "block",
            reason: "sensitive command",
            hookDecision: "block",
          },
          source: "harness",
        },
      },
      stderr: "sensitive command",
    });
  });

  it("bounds retry decisions with attempt metadata", () => {
    const retry = resolveHookDecisionResult(
      action(),
      { decision: "retry", reason: "recover permission" },
      { attempt: 1, maxRetries: 2 },
    );
    expect(retry).toMatchObject({
      status: "ok",
      value: {
        retry: true,
        exhausted: false,
        attempt: 1,
        maxRetries: 2,
      },
    });

    const exhausted = resolveHookDecisionResult(
      action(),
      { decision: "retry", reason: "recover permission" },
      { attempt: 2, maxRetries: 2 },
    );
    expect(exhausted).toMatchObject({
      status: "error",
      value: {
        retry: false,
        exhausted: true,
        attempt: 2,
        maxRetries: 2,
      },
    });
  });

  it("turns continueSession false into an abort result", () => {
    const result = resolveHookDecisionResult(
      action(),
      { continueSession: false, stopReason: "hook stopped session" },
    );

    expect(result).toMatchObject({
      status: "error",
      value: {
        aborted: true,
        stopReason: "hook stopped session",
      },
      stderr: "hook stopped session",
    });
  });
});

describe("usage limit errors", () => {
  it("are retryable and recognised as a usage limit", () => {
    const message = "You've hit your session limit · resets 4:50am (Asia/Hebron)\nAgent crashed";
    expect(isUsageLimitError(message)).toBe(true);
    expect(isRetryableEffectError(message)).toBe(true);
    expect(isUsageLimitError("Agent crashed")).toBe(false);
  });
});

describe("usageLimitResetAt", () => {
  const now = new Date(2026, 9, 26, 4, 16); // 26 Oct 2026, 04:16 local time

  it("reads a Claude reset time later today", () => {
    const at = usageLimitResetAt("You've hit your session limit · resets 4:50am (Asia/Hebron)", now)!;
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([26, 4, 50]);
  });

  it("rolls a time already past over to tomorrow", () => {
    const at = usageLimitResetAt("You've hit your session limit · resets 3am", now)!;
    expect([at.getDate(), at.getHours()]).toEqual([27, 3]);
  });

  it("reads a weekly reset with a date", () => {
    const at = usageLimitResetAt("You've hit your weekly limit · resets Oct 30, 9pm (Asia/Hebron)", now)!;
    expect([at.getMonth(), at.getDate(), at.getHours()]).toEqual([9, 30, 21]);
  });

  it("reads Codex's 'try again at' and relative forms", () => {
    const at = usageLimitResetAt("You've hit your usage limit. Try again at 5:23 PM.", now)!;
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([26, 17, 23]);
    const later = usageLimitResetAt("Usage limit reached, try again in 2 hours", now)!;
    expect(later.getTime() - now.getTime()).toBe(2 * 3_600_000);
  });

  it("returns null when the message names no time", () => {
    expect(usageLimitResetAt("Usage limit reached", now)).toBeNull();
  });
});
