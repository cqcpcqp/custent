import type { AgentInputItem, Session } from "@openai/agents";

export type PostgresSessionStorage = {
  getItems(sessionId: string, limit?: number): Promise<AgentInputItem[]>;
  addItems(sessionId: string, items: AgentInputItem[]): Promise<void>;
  popItem(sessionId: string): Promise<AgentInputItem | undefined>;
  clearSession(sessionId: string): Promise<void>;
};

export class PostgresSession implements Session {
  constructor(
    private readonly sessionId: string,
    private readonly storage: PostgresSessionStorage,
  ) {
    if (sessionId.length === 0) {
      throw new TypeError("sessionId must not be empty");
    }
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.storage.getItems(this.sessionId, limit);
  }

  addItems(items: AgentInputItem[]): Promise<void> {
    return this.storage.addItems(this.sessionId, items);
  }

  popItem(): Promise<AgentInputItem | undefined> {
    return this.storage.popItem(this.sessionId);
  }

  clearSession(): Promise<void> {
    return this.storage.clearSession(this.sessionId);
  }
}

