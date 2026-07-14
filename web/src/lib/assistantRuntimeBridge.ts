import {
  type AssistantRuntime,
  type AttachmentAdapter,
  type ExternalStoreAdapter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMemo } from "react";
import type { ChatMessage } from "../types";
import type { FileInfo } from "./chatReducer";
import { getComposerPayload, toAssistantMessage } from "./chatMessageAdapter";

export interface ChatRuntimeInput {
  messages: readonly ChatMessage[];
  loading: boolean;
  send: (text: string, files?: FileInfo[]) => Promise<void>;
  attachmentAdapter: AttachmentAdapter;
}

export function createChatRuntimeAdapter(
  input: ChatRuntimeInput,
): ExternalStoreAdapter<ChatMessage> {
  return {
    messages: input.messages,
    isLoading: input.loading,
    isRunning: false,
    convertMessage: toAssistantMessage,
    adapters: { attachments: input.attachmentAdapter },
    onNew: async (message) => {
      const { text, files } = getComposerPayload(message);
      if (!text.trim() && files.length === 0) return;
      await input.send(text, files.length > 0 ? files : undefined);
    },
  };
}

export function useAssistantRuntimeBridge(input: ChatRuntimeInput): AssistantRuntime {
  const adapter = useMemo(
    () => createChatRuntimeAdapter(input),
    [input.messages, input.loading, input.send, input.attachmentAdapter],
  );
  return useExternalStoreRuntime(adapter);
}
