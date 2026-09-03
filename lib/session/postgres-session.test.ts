import type { AgentInputItem } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresSession,
  type PostgresSessionStorage,
} from "./postgres-session";

function createStorage(): PostgresSessionStorage {
  return {
    getItems: vi.fn(async () => []),
    addItems: vi.fn(async () => undefined),
    popItem: vi.fn(async () => undefined),
    clearSession: vi.fn(async () => undefined),
  };
}

describe("PostgresSession", () => {
  it("delegates every Session operation with the stable session id", async () => {
    const item: AgentInputItem = { role: "user", content: "hello" };
    const storage = createStorage();
    vi.mocked(storage.getItems).mockResolvedValue([item]);
    vi.mocked(storage.popItem).mockResolvedValue(item);
    const session = new PostgresSession("conversation-123", storage);

    await expect(session.getSessionId()).resolves.toBe("conversation-123");
    await expect(session.getItems(8)).resolves.toEqual([item]);
    await session.addItems([item]);
    await expect(session.popItem()).resolves.toEqual(item);
    await session.clearSession();

    expect(storage.getItems).toHaveBeenCalledWith("conversation-123", 8);
    expect(storage.addItems).toHaveBeenCalledWith("conversation-123", [item]);
    expect(storage.popItem).toHaveBeenCalledWith("conversation-123");
    expect(storage.clearSession).toHaveBeenCalledWith("conversation-123");
  });

  it("passes an omitted limit through without inventing storage behavior", async () => {
    const storage = createStorage();
    const session = new PostgresSession("conversation-123", storage);

    await session.getItems();

    expect(storage.getItems).toHaveBeenCalledWith(
      "conversation-123",
      undefined,
    );
  });

  it("rejects an empty session id", () => {
    expect(() => new PostgresSession("", createStorage())).toThrow(
      "sessionId must not be empty",
    );
  });
});

