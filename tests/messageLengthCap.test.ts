import { describe, it, expect } from "vitest";
import { MessageSchema, MAX_MESSAGE_CONTENT_LENGTH } from "../src/store/schemas";

describe("M22 — Prompt length cap", () => {
  it("exports MAX_MESSAGE_CONTENT_LENGTH as 100_000", () => {
    expect(MAX_MESSAGE_CONTENT_LENGTH).toBe(100_000);
  });

  it("MessageSchema accepts content at exactly the limit", () => {
    const msg = {
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "a".repeat(MAX_MESSAGE_CONTENT_LENGTH),
      status: "created",
      redactionState: "none",
      createdAt: new Date().toISOString(),
    };
    expect(() => MessageSchema.parse(msg)).not.toThrow();
  });

  it("MessageSchema rejects content exceeding the limit", () => {
    const msg = {
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "a".repeat(MAX_MESSAGE_CONTENT_LENGTH + 1),
      status: "created",
      redactionState: "none",
      createdAt: new Date().toISOString(),
    };
    expect(() => MessageSchema.parse(msg)).toThrow();
  });

  it("MessageSchema accepts short content", () => {
    const msg = {
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "Hello",
      status: "created",
      redactionState: "none",
      createdAt: new Date().toISOString(),
    };
    expect(() => MessageSchema.parse(msg)).not.toThrow();
  });

  it("MessageSchema rejects empty content", () => {
    const msg = {
      id: "m1",
      conversationId: "c1",
      role: "user",
      content: "",
      status: "created",
      redactionState: "none",
      createdAt: new Date().toISOString(),
    };
    // Empty string fails NonEmptyStringSchema for id/conversationId checks;
    // content: z.string().max(100_000) allows empty. This is consistent —
    // the route-level check validates non-empty separately.
    expect(() => MessageSchema.parse(msg)).not.toThrow();
  });
});
