import {
  type AssistantRuntime,
  type AttachmentAdapter,
  type ExternalStoreAdapter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMemo } from "react";
import type { ChatMessage } from "../types";
import { getComposerPayload, toAssistantMessage } from "./chatMessageAdapter";
import type { FileInfo } from "./chatReducer";

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
  const { messages, loading, send, attachmentAdapter } = input;
  const adapter = useMemo(
    () => createChatRuntimeAdapter({ messages, loading, send, attachmentAdapter }),
    [messages, loading, send, attachmentAdapter],
  );
  return useExternalStoreRuntime(adapter);
}
