import { describe, expect, it } from "vitest";
import { splitTelegramReasoningText } from "./reasoning-lane-coordinator.js";

describe("splitTelegramReasoningText", () => {
  it("splits real tagged reasoning and answer", () => {
    expect(splitTelegramReasoningText("<think>example</think>Done")).toEqual({
      reasoningText: "Reasoning:\n_example_",
      answerText: "Done",
    });
  });

  it("ignores literal think tags inside inline code", () => {
    const text = "Use `<think>example</think>` literally.";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("ignores literal think tags inside fenced code", () => {
    const text = "```xml\n<think>example</think>\n```";
    expect(splitTelegramReasoningText(text)).toEqual({
      answerText: text,
    });
  });

  it("does not emit partial reasoning tag prefixes", () => {
    expect(splitTelegramReasoningText("  <thi")).toEqual({});
  });

  it("suppresses answer leakage when closing tag is incomplete during streaming", () => {
    // As </thinking> arrives char-by-char, extractThinking captures content via the
    // complete opening tag but strict stripReasoningTags can't strip the partial closer,
    // returning the original text as strippedAnswer. Without the fix this leaks into
    // the answer lane as raw <thinking>-tagged content.
    const result = splitTelegramReasoningText("<thinking>Some reasoning</thinking");
    expect(result.reasoningText).toBeDefined();
    expect(result.answerText).toBeUndefined();
  });
});
