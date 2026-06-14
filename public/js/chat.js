// Auto-split from app.js — module: chat. Behavior-preserving relocation only.
// This file is now a thin BARREL re-exporting the public chat API from the
// cohesive submodules under ./chat/. The 19 symbols below are the exact set
// imported by sibling modules via `from "./chat.js"` — import paths are stable.
export { streamingPane, guardChatReplacement, makeChatPane, activePane, setActivePane, syncLegacyChatState, anyChatStreaming, stopAllChatStreams } from "./chat/panes.js";
export { renderChat, chatAboutTopic } from "./chat/view.js";
export { isFinePointer, capPref, setCapPref, invalidateSkillsCache } from "./chat/capabilities.js";
export { renderAssistantInto } from "./chat/assistant.js";
export { consumeSse } from "./chat/stream.js";
export { refreshConversations, renderConversations, selectConversation } from "./chat/conversations.js";
