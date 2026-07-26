// ChatView transcript rendering. Guards the deferred-card behavior that keeps a
// long transcript cheap: <details> only HIDES its children, so leaving the
// "생각 과정" body and the "작업 내역" tree in the template cost a markdown parse
// and an ActivityTree mount for EVERY message on load. Both now render on first
// open. See lib/format.ts renderMarkdownCached for the matching per-token fix.
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { replaceState } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail, StoredMessage } from "../src/server/types.js";

const THINKING = "먼저 요구사항을 정리한다";
const ANSWER = "정리한 결과입니다";

const avatar = {
  id: "avatar-1",
  username: "ava",
  displayName: "아바타",
  alias: "",
  bio: "",
  persona: "",
  intro: "",
  hashtags: [],
  hasImage: false,
  visibility: "public",
  isOwn: true,
  elevated: true,
  plugins: [],
} as unknown as AvatarDetail;

function assistantMessage(): StoredMessage {
  return {
    id: "m-1",
    conversationId: "conv-1",
    role: "assistant",
    content: ANSWER,
    createdAt: "2026-07-26T01:00:00.000Z",
    response: {
      kind: "text",
      runtime: "claude",
      summary: "완료",
      text: ANSWER,
      thinking: THINKING,
      activity: {
        agents: [{ id: "main", parentId: "", label: "main", status: "done", isMain: true }],
        tools: [{ id: "t-1", agentId: "main", kind: "tool", label: "Read", detail: "notes.md", status: "done" }],
        tasks: [],
      },
    },
  } as unknown as StoredMessage;
}

function pane(messages: StoredMessage[]): ChatPane {
  return {
    id: "pane-1",
    avatar,
    conversationId: "conv-1",
    messages,
    draft: "",
    streaming: false,
    liveText: "",
    liveAttachments: [],
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    groupKnowledgeOff: [],
  } as unknown as ChatPane;
}

// `toggle` is queued as a TASK after `open` flips (per spec, and jsdom matches),
// so a click needs one macrotask before the handler has run — a microtask tick is
// not enough. The browser paints only after that task, so there is no real flash.
async function clickSummary(card: HTMLDetailsElement): Promise<void> {
  await fireEvent.click(card.querySelector("summary")!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
  // ChatView's mount fires background loads; answer them with empty collections
  // so a missing key can't overwrite seeded state with undefined.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ avatars: [], conversations: [], messages: [], skills: [] }),
    })),
  );
  replaceState({ avatars: [], chatPanes: [pane([assistantMessage()])], activePaneId: "pane-1" });
});

describe("ChatView transcript", () => {
  it("renders the answer body but defers the thinking / activity cards until opened", async () => {
    const { container } = render(ChatView);

    // The answer itself is always rendered — only the collapsed cards are deferred.
    expect(container.querySelector(".message.assistant .md")?.textContent).toContain(ANSWER);
    expect(screen.getByText("생각 과정")).toBeTruthy();
    expect(container.querySelector(".thinking-card-body")).toBeNull();
    expect(container.querySelector(".agent-activity")).toBeNull();

    // Drive it the way a user does — click the <summary>; jsdom flips `open` and
    // fires `toggle`, so this covers the real wiring, not just the handler.
    const thinkingCard = container.querySelector<HTMLDetailsElement>("details.thinking-card")!;
    await clickSummary(thinkingCard);
    expect(thinkingCard.open).toBe(true);
    expect(container.querySelector(".thinking-card-body")?.textContent).toContain(THINKING);

    const activityCard = container.querySelector<HTMLDetailsElement>("details.activity-done")!;
    await clickSummary(activityCard);
    expect(container.querySelector(".agent-activity")).not.toBeNull();

    // Closing releases the body again, so scrolling past reopened cards stays cheap.
    await clickSummary(thinkingCard);
    expect(thinkingCard.open).toBe(false);
    expect(container.querySelector(".thinking-card-body")).toBeNull();
  });
});
