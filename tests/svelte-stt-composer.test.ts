// The composer's voice-input wiring: the mic exists only where the deployment
// enabled STT, the grid falls back to its old shape when it does not, a take
// lands in the pane's DRAFT (not the DOM — the textarea is one-way bound), and
// one recording locks the mic in every other pane. The media plumbing itself is
// unit-tested in client-stt.test.ts; this file pins what only a real render can
// show.
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatView from "../src/client/src/views/ChatView.svelte";
import { readState, replaceState, toasts } from "../src/client/src/lib/state.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail } from "../src/server/types.js";

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
  visibility: "group",
  isOwn: true,
  elevated: true,
  plugins: [],
} as unknown as AvatarDetail;

function pane(id: string, draft = ""): ChatPane {
  return {
    id,
    avatar,
    conversationId: `conv-${id}`,
    messages: [],
    draft,
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

function seed(opts: { sttEnabled?: boolean; panes?: ChatPane[] } = {}): void {
  const panes = opts.panes ?? [pane("pane-1")];
  replaceState({
    avatars: [],
    chatPanes: panes,
    activePaneId: panes[0].id,
    view: "chat",
    bootstrap: { visionEnabled: true, ...(opts.sttEnabled === undefined ? {} : { sttEnabled: opts.sttEnabled }) },
  } as unknown as Parameters<typeof replaceState>[0]);
}

// Minimal stand-ins for the two APIs jsdom lacks. The recorder flushes its
// buffered chunk on stop() and then fires "stop", the order the module's tail
// depends on.
class FakeMediaRecorder {
  static isTypeSupported(type: string): boolean {
    return type === "audio/webm;codecs=opus";
  }
  state = "inactive";
  mimeType: string;
  private listeners: Record<string, Array<(event: Event) => void>> = {};
  constructor(_stream: MediaStream, options: { mimeType?: string } = {}) {
    this.mimeType = options.mimeType ?? "";
  }
  addEventListener(type: string, cb: (event: Event) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  private emit(type: string, props: Record<string, unknown> = {}): void {
    const event = Object.assign(new Event(type), props);
    for (const cb of this.listeners[type] || []) cb(event);
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    this.emit("dataavailable", { data: new Blob(["bytes"], { type: "audio/webm" }) });
    this.emit("stop");
  }
}

function installMic(getUserMedia?: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia:
        getUserMedia ?? (async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream),
    },
    configurable: true,
    writable: true,
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
}

function micButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button.composer-mic");
  expect(button).toBeTruthy();
  return button!;
}

function composerBox(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".composer-box")!;
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(path).startsWith("/api/stt")
          ? { text: "회의 내용 정리해 줘" }
          : { avatars: [], conversations: [], messages: [], skills: [] },
    })),
  );
  toasts.set([]);
});

describe("composer mic button", () => {
  it("appears only when the deployment enabled STT, and the grid follows", () => {
    seed({ sttEnabled: true });
    const on = render(ChatView);
    expect(on.container.querySelector("button.composer-mic")).toBeTruthy();
    expect(composerBox(on.container).classList.contains("no-stt")).toBe(false);
    expect(micButton(on.container).title).toBe("음성 입력");
    on.unmount();

    // Absent flag (older server) reads the same as off: no button, old 3-column grid.
    seed();
    const off = render(ChatView);
    expect(off.container.querySelector("button.composer-mic")).toBeNull();
    expect(composerBox(off.container).classList.contains("no-stt")).toBe(true);
  });

  it("names voice input in the empty-composer send hint only when it is available", () => {
    seed({ sttEnabled: true });
    const on = render(ChatView);
    expect(on.container.querySelector<HTMLButtonElement>(".send-button")!.title).toBe(
      "메시지, 이미지 또는 음성을 추가하세요",
    );
    on.unmount();

    seed();
    const off = render(ChatView);
    expect(off.container.querySelector<HTMLButtonElement>(".send-button")!.title).toBe(
      "메시지 또는 이미지를 추가하세요",
    );
  });

  it("records, then appends the transcript to the existing draft through the store", async () => {
    installMic();
    seed({ sttEnabled: true, panes: [pane("pane-1", "메모")] });
    const { container } = render(ChatView);

    await fireEvent.click(micButton(container));
    await waitFor(() => expect(micButton(container).classList.contains("recording")).toBe(true));
    expect(micButton(container).title).toBe("녹음 중지");
    expect(micButton(container).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".composer-stt")?.textContent).toContain("녹음 중");

    await fireEvent.click(micButton(container));
    // Draft, not a DOM write: the textarea is one-way bound to it.
    await waitFor(() => expect(readState().chatPanes[0].draft).toBe("메모 회의 내용 정리해 줘"));
    expect(container.querySelector<HTMLTextAreaElement>(".composer textarea")!.value).toBe("메모 회의 내용 정리해 줘");
    expect(micButton(container).title).toBe("음성 입력"); // back to idle
    expect(container.querySelector(".composer-stt")).toBeNull();
  });

  it("surfaces a denied mic as a toast and leaves the draft alone", async () => {
    installMic(async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    });
    seed({ sttEnabled: true });
    const { container } = render(ChatView);

    await fireEvent.click(micButton(container));
    await waitFor(() =>
      expect(get(toasts).some((t) => t.kind === "warn" && t.message.includes("마이크 사용 권한이 필요해요"))).toBe(
        true,
      ),
    );
    expect(readState().chatPanes[0].draft).toBe("");
    expect(micButton(container).title).toBe("음성 입력");
  });

  it("locks every other pane's mic while one take is running", async () => {
    installMic();
    seed({ sttEnabled: true, panes: [pane("pane-1"), pane("pane-2")] });
    const { container } = render(ChatView);

    const mics = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button.composer-mic"));
    expect(mics()).toHaveLength(2);

    await fireEvent.click(mics()[0]);
    await waitFor(() => expect(mics()[1].disabled).toBe(true));
    // A disabled control has to say why it is disabled.
    expect(mics()[1].title).toBe("다른 대화에서 녹음 중입니다");
    expect(mics()[0].disabled).toBe(false); // the owner can still stop it

    await fireEvent.click(mics()[0]);
    await waitFor(() => expect(mics()[1].disabled).toBe(false));
  });
});
