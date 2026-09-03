import {
  createAgentRuntimeFactory,
  type AgentRuntimeFactory,
} from "@/lib/agent";
import { getEnv } from "@/lib/env";

import { agentToolServices } from "./tool-services";

let runtimeFactory: AgentRuntimeFactory | undefined;

export function getChatAgentRuntimeFactory(): AgentRuntimeFactory {
  if (runtimeFactory !== undefined) {
    return runtimeFactory;
  }

  const env = getEnv();
  runtimeFactory = createAgentRuntimeFactory({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    provider: env.OPENAI_PROVIDER,
    reasoningModeCapabilityEnabled:
      env.OPENAI_REASONING_MODE_ENABLED,
    codeInterpreterCapabilityEnabled:
      env.OPENAI_CODE_INTERPRETER_ENABLED,
    services: agentToolServices,
  });
  return runtimeFactory;
}

export function resetChatAgentRuntimeFactoryForTests(): void {
  runtimeFactory = undefined;
}
