// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import {
  activePane,
  appState,
  dismissToast,
  newId,
  notify,
  readState,
  replaceState,
  setDocumentTitle,
  toasts,
  updateState,
} from "../src/client/src/lib/state.js";
import { consumeSse } from "../src/client/src/lib/sse.js";
import { api, refreshMe, setSessionExpiredHandler } from "../src/client/src/lib/api.js";
import {
  ensureNotificationPermission,
  notificationsSupported,
  osNotify,
} from "../src/client/src/lib/notifications.js";
import {
  SLASH_COMMANDS,
  commandsForPane,
  filterSlashCommands,
  menuCommandsForPane,
  resolveTypedSlashCommand,
  skillToSlashCommand,
} from "../src/client/src/lib/slash.js";
import {
  applyInitialRoute,
  currentRoute,
  goView,
  installRouteListener,
  routeFromHash,
  syncHash,
} from "../src/client/src/lib/nav.js";
import { recordKnowledgeViaAvatar } from "../src/client/src/lib/knowledge.js";
import {
  loadAdminGroups,
  loadAdminOverview,
  loadAvatars,
  loadConversations,
  loadInboxData,
  loadRoutinesData,
  loadSettingsData,
  refreshKnowledgeStatus,
  refreshNotificationStatus,
  startKnowledgeWatch,
  stopKnowledgeWatch,
} from "../src/client/src/lib/loaders.js";
import {
  avatarGradient,
  avatarImageUrl,
  formatDate,
  formatRoutineSchedule,
  formatTokenCount,
  hashHue,
  initials,
  minuteToTime,
  normalizeTags,
  renderMarkdown,
  repoToHref,
  routineTitle,
  timeLabel,
  timeToMinute,
} from "../src/client/src/lib/format.js";

/* ------------------------------------------------------------------ */
/* shared fixtures + fetch stubbing                                    */
/* ------------------------------------------------------------------ */

// Pristine store snapshot captured before any test mutates the singleton.
const PRISTINE = structuredClone(readState());

type FetchHandler = (url: string, init: RequestInit) => unknown;

/** Route fetch calls through `handler`; returning undefined signals an unmocked URL. */
function useFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const res = handler(String(input), init);
    if (res === undefined) throw new Error(`unhandled fetch: ${String(input)}`);
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

function sseRes(chunks: string[], status = 200) {
  return { ok: status >= 200 && status < 300, status, body: streamFrom(chunks), json: async () => ({}) };
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  // Clear any residual hash so nav routing starts from a known base.
  history.replaceState(null, "", "/");
  setSessionExpiredHandler(() => {});
});

afterEach(() => {
  // stopKnowledgeWatch also zeroes the module-level announce baselines.
  stopKnowledgeWatch();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* state.ts                                                            */
/* ------------------------------------------------------------------ */

describe("state store", () => {
  it("updateState mutates in place and recomputes `streaming` from panes", () => {
    updateState((s) => {
      s.chatPanes = [{ id: "p1", streaming: false } as any];
    });
    expect(readState().streaming).toBe(false);
    updateState((s) => {
      s.chatPanes[0].streaming = true;
    });
    expect(readState().streaming).toBe(true);
  });

  it("replaceState merges a partial and recomputes `streaming`", () => {
    replaceState({ view: "inbox", chatPanes: [{ id: "p", streaming: true } as any] });
    const s = readState();
    expect(s.view).toBe("inbox");
    expect(s.streaming).toBe(true);
  });

  it("activePane returns the active pane, else the first, else null", () => {
    expect(activePane()).toBeNull();
    updateState((s) => {
      s.chatPanes = [{ id: "a" } as any, { id: "b" } as any];
      s.activePaneId = "b";
    });
    expect(activePane()?.id).toBe("b");
    updateState((s) => {
      s.activePaneId = "nope";
    });
    // Falls back to the first pane when the active id no longer matches.
    expect(activePane()?.id).toBe("a");
  });

  it("newId yields unique ids and falls back when crypto.randomUUID is absent", () => {
    expect(newId()).not.toBe(newId());
    vi.stubGlobal("crypto", {});
    const id = newId();
    expect(id).toContain("-");
    expect(typeof id).toBe("string");
  });

  it("notify pushes a toast, defaults kind to warn, and caps the list at four", () => {
    notify("첫 경고");
    const first = get(toasts)[0];
    expect(first.kind).toBe("warn");
    expect(first.message).toBe("첫 경고");
    for (let i = 0; i < 5; i++) notify(`m${i}`, "info");
    expect(get(toasts)).toHaveLength(4);
  });

  it("notify with an action gets the longer duration and auto-dismisses on timeout", () => {
    vi.useFakeTimers();
    const action = vi.fn();
    notify("작업 알림", "info", { actionLabel: "열기", action });
    const toast = get(toasts).at(-1)!;
    expect(toast.actionLabel).toBe("열기");
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(9000);
    expect(get(toasts)).toHaveLength(0);
  });

  it("dismissToast removes a toast by id", () => {
    notify("사라질 토스트", "ok");
    const id = get(toasts)[0].id;
    dismissToast(id);
    expect(get(toasts)).toHaveLength(0);
  });

  it("setDocumentTitle reflects streaming / logged-out / per-view titles", () => {
    setDocumentTitle();
    expect(document.title).toBe("Noah Almighty");
    replaceState({ user: { id: "u", roles: [] } as any, view: "explore" });
    setDocumentTitle();
    expect(document.title).toBe("탐색 · Noah Almighty");
    updateState((s) => {
      s.chatPanes = [{ id: "p", streaming: true, avatar: { alias: "노아" } } as any];
    });
    setDocumentTitle();
    expect(document.title).toBe("● 응답 중 · Noah Almighty");
  });
});

/* ------------------------------------------------------------------ */
/* sse.ts                                                              */
/* ------------------------------------------------------------------ */

describe("consumeSse", () => {
  async function collect(chunks: string[]) {
    const frames: { event: string; id: string; data: any }[] = [];
    await consumeSse(streamFrom(chunks), (f) => frames.push(f));
    return frames;
  }

  it("parses id / event / JSON-data frames", async () => {
    const frames = await collect([
      "id: 1\nevent: open\ndata: {\"conversationId\":\"c1\"}\n\n",
      "event: delta\ndata: {\"text\":\"hi\"}\n\n",
    ]);
    expect(frames).toEqual([
      { id: "1", event: "open", data: { conversationId: "c1" } },
      { id: "", event: "delta", data: { text: "hi" } },
    ]);
  });

  it("joins multi-line data, strips CR, and ignores comment/blank lines", async () => {
    const frames = await collect([": keep-alive\nevent: note\ndata: line1\r\ndata: line2\n\n"]);
    expect(frames).toHaveLength(1);
    // Non-JSON payload → wrapped as { text }, newline-joined.
    expect(frames[0]).toEqual({ id: "", event: "note", data: { text: "line1\nline2" } });
  });

  it("flushes a trailing frame that has no terminating blank line", async () => {
    const frames = await collect(["event: done\ndata: {\"ok\":true}"]);
    expect(frames).toEqual([{ id: "", event: "done", data: { ok: true } }]);
  });

  it("reassembles a frame split across stream reads", async () => {
    const frames = await collect(["event: delta\nda", "ta: {\"text\":\"split\"}\n\n"]);
    expect(frames).toEqual([{ id: "", event: "delta", data: { text: "split" } }]);
  });

  it("drops a frame that carries no data line", async () => {
    const frames = await collect(["event: ping\n\n"]);
    expect(frames).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* api.ts                                                              */
/* ------------------------------------------------------------------ */

describe("api()", () => {
  it("returns the parsed body on success", async () => {
    useFetch((url) => (url === "/api/thing" ? jsonRes({ value: 42 }) : undefined));
    await expect(api<{ value: number }>("/api/thing")).resolves.toEqual({ value: 42 });
  });

  it("maps a known server error to Korean, else surfaces the raw error", async () => {
    useFetch(() => jsonRes({ error: "Authentication required" }, 403));
    await expect(api("/x")).rejects.toThrow("로그인이 필요합니다.");
    useFetch(() => jsonRes({ error: "custom boom" }, 400));
    await expect(api("/x")).rejects.toThrow("custom boom");
  });

  it("uses a generic coded message when the body has no error string", async () => {
    useFetch(() => jsonRes({}, 500));
    await expect(api("/x")).rejects.toThrow("코드 500");
  });

  it("fires the session-expired handler on 401 while logged in", async () => {
    replaceState({ user: { id: "u" } as any });
    const onExpire = vi.fn();
    setSessionExpiredHandler(onExpire);
    useFetch(() => jsonRes({}, 401));
    await expect(api("/x")).rejects.toThrow("세션이 만료되었습니다");
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("treats a 401 as a normal error when logged out", async () => {
    const onExpire = vi.fn();
    setSessionExpiredHandler(onExpire);
    useFetch(() => jsonRes({}, 401));
    await expect(api("/x")).rejects.toThrow("코드 401");
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("translates a fetch TimeoutError and a network failure; rethrows AbortError", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    await expect(api("/x")).rejects.toThrow("요청 시간이 초과되었습니다");

    vi.stubGlobal("fetch", async () => {
      throw new Error("boom");
    });
    await expect(api("/x")).rejects.toThrow("서버에 연결할 수 없습니다");

    const abortErr = Object.assign(new Error("stop"), { name: "AbortError" });
    vi.stubGlobal("fetch", async () => {
      throw abortErr;
    });
    await expect(api("/x")).rejects.toBe(abortErr);
  });

  it("refreshMe stores the returned user", async () => {
    useFetch((url) => (url === "/api/me" ? jsonRes({ user: { id: "me", roles: [] } }) : undefined));
    await refreshMe();
    expect(readState().user?.id).toBe("me");
  });
});

/* ------------------------------------------------------------------ */
/* notifications.ts                                                    */
/* ------------------------------------------------------------------ */

class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  static instances: MockNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    MockNotification.instances.push(this);
  }
}

function stubNotification(permission: NotificationPermission = "granted") {
  MockNotification.permission = permission;
  MockNotification.instances = [];
  MockNotification.requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  vi.stubGlobal("Notification", MockNotification);
}

describe("notifications", () => {
  it("notificationsSupported reflects the Notification global", () => {
    expect(notificationsSupported()).toBe(false);
    stubNotification();
    expect(notificationsSupported()).toBe(true);
  });

  it("ensureNotificationPermission only prompts while permission is default", async () => {
    stubNotification("granted");
    await ensureNotificationPermission();
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();

    stubNotification("default");
    await ensureNotificationPermission();
    expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("ensureNotificationPermission swallows a throwing requestPermission", async () => {
    stubNotification("default");
    MockNotification.requestPermission = vi.fn(async () => {
      throw new Error("legacy callback form");
    });
    await expect(ensureNotificationPermission()).resolves.toBeUndefined();
  });

  it("osNotify no-ops without permission or while the app is focused", () => {
    stubNotification("default"); // not granted
    osNotify("t", "b");
    expect(MockNotification.instances).toHaveLength(0);

    stubNotification("granted");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    osNotify("t", "b");
    expect(MockNotification.instances).toHaveLength(0);
  });

  it("osNotify constructs a Notification when backgrounded, wiring onclick to focus", () => {
    stubNotification("granted");
    vi.spyOn(document, "hasFocus").mockReturnValue(false); // backgrounded
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    osNotify("제목", "본문", "tag-1");
    expect(MockNotification.instances).toHaveLength(1);
    const note = MockNotification.instances[0];
    expect(note.title).toBe("제목");
    expect(note.options).toMatchObject({ body: "본문", tag: "tag-1", renotify: true });
    note.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(note.close).toHaveBeenCalled();
  });

  it("osNotify swallows a throwing Notification constructor", () => {
    class Throwing {
      static permission = "granted";
      constructor() {
        throw new Error("android without SW");
      }
    }
    vi.stubGlobal("Notification", Throwing);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(() => osNotify("t", "b")).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* slash.ts                                                            */
/* ------------------------------------------------------------------ */

describe("slash commands", () => {
  const ownPane = { avatar: { id: "me", isOwn: true } } as any;
  const otherPane = { avatar: { id: "other", isOwn: false } } as any;

  it("hides owner-only commands unless the pane belongs to the owner", () => {
    const guest = commandsForPane(otherPane).map((c) => c.name);
    expect(guest).toContain("summarize");
    expect(guest).not.toContain("remember");

    const owner = commandsForPane(ownPane).map((c) => c.name);
    expect(owner).toContain("remember");
    expect(owner).toContain("learn");
  });

  it("treats a pane whose avatar id equals the current user as owner-owned", () => {
    replaceState({ user: { id: "u1" } as any });
    const pane = { avatar: { id: "u1", isOwn: false } } as any;
    expect(commandsForPane(pane).map((c) => c.name)).toContain("remember");
  });

  it("resolves a typed slash command with trimmed args, rejecting //, unknown, and non-slash text", () => {
    expect(resolveTypedSlashCommand(ownPane, "/new")).toMatchObject({ command: { name: "new" }, args: "" });
    expect(resolveTypedSlashCommand(ownPane, "/remember   기억할 것  ")).toMatchObject({
      command: { name: "remember" },
      args: "기억할 것",
    });
    expect(resolveTypedSlashCommand(ownPane, "//literal")).toBeNull();
    expect(resolveTypedSlashCommand(ownPane, "/nope")).toBeNull();
    expect(resolveTypedSlashCommand(ownPane, "just text")).toBeNull();
    // owner-only command is unresolvable from a guest pane
    expect(resolveTypedSlashCommand(otherPane, "/remember x")).toBeNull();
  });

  it("skillToSlashCommand builds a menu entry whose prompt names the skill", () => {
    const cmd = skillToSlashCommand({ name: "deep-research", description: "리서치", source: "core" } as any);
    expect(cmd).toMatchObject({ name: "deep-research", kind: "skill", source: "core" });
    expect(cmd.prompt?.("")).toContain('"deep-research"');
    expect(cmd.prompt?.("추가 지시")).toContain("추가 지시");
  });

  it("menuCommandsForPane appends installed skills to the built-ins", () => {
    const pane = { avatar: { id: "me", isOwn: true }, skills: [{ name: "wrap-up", description: "d" }] } as any;
    const names = menuCommandsForPane(pane).map((c) => c.name);
    expect(names).toContain("summarize");
    expect(names).toContain("wrap-up");
  });

  it("filterSlashCommands matches across name/title/description/source and returns all on empty query", () => {
    expect(filterSlashCommands(SLASH_COMMANDS, "")).toBe(SLASH_COMMANDS);
    const byTitle = filterSlashCommands(SLASH_COMMANDS, "요약");
    expect(byTitle.map((c) => c.name)).toEqual(["summarize"]);
  });
});

/* ------------------------------------------------------------------ */
/* nav.ts                                                              */
/* ------------------------------------------------------------------ */

describe("nav routing", () => {
  it("routeFromHash parses valid views + args and rejects bad ones", () => {
    history.replaceState(null, "", "#/settings/access");
    expect(routeFromHash()).toEqual({ view: "settings", arg: "access" });
    history.replaceState(null, "", "#/bogus");
    expect(routeFromHash()).toEqual({ view: null, arg: null });
    history.replaceState(null, "", "#/chat/%E2%9C%93");
    expect(routeFromHash()).toEqual({ view: "chat", arg: "✓" });
    // malformed percent-encoding decodes to null rather than throwing
    history.replaceState(null, "", "#/chat/%E0%A4%A");
    expect(routeFromHash()).toEqual({ view: "chat", arg: null });
  });

  it("currentRoute renders the per-view hash from store state", () => {
    replaceState({ view: "settings", settingsTab: "knowledge" });
    expect(currentRoute()).toBe("#/settings/knowledge");
    replaceState({ view: "admin", adminTab: "audit" });
    expect(currentRoute()).toBe("#/admin/audit");
    replaceState({ view: "brain", brainSource: "group:42" });
    expect(currentRoute()).toBe("#/brain/group%3A42");
    replaceState({ view: "brain", brainSource: "personal" });
    expect(currentRoute()).toBe("#/brain");
    replaceState({
      view: "chat",
      chatPanes: [{ id: "p", conversationId: "conv7" } as any],
      activePaneId: "p",
    });
    expect(currentRoute()).toBe("#/chat/conv7");
  });

  it("syncHash pushes the target only for a logged-in user with a changed hash", () => {
    const push = vi.spyOn(history, "pushState");
    replaceState({ user: null, view: "explore" });
    syncHash();
    expect(push).not.toHaveBeenCalled(); // no user → no-op

    replaceState({ user: { id: "u" } as any, view: "explore" });
    syncHash();
    expect(push).toHaveBeenCalledWith(null, "", "#/explore");
    push.mockClear();
    // Now the hash already matches the target → no second push.
    syncHash();
    expect(push).not.toHaveBeenCalled();
  });

  it("goView switches views and redirects a non-admin away from admin", () => {
    replaceState({ user: { id: "u", roles: [] } as any });
    goView("admin");
    expect(readState().view).toBe("explore");

    replaceState({ user: { id: "u", roles: ["admin"] } as any });
    goView("admin", "system");
    expect(readState()).toMatchObject({ view: "admin", adminTab: "system" });

    goView("settings", "groups");
    expect(readState()).toMatchObject({ view: "settings", settingsTab: "groups" });
  });

  it("applyInitialRoute hydrates the store from the current hash", () => {
    replaceState({ user: { id: "u", roles: [] } as any });
    history.replaceState(null, "", "#/routines/conv9");
    applyInitialRoute();
    expect(readState()).toMatchObject({ view: "routines", routineConversationId: "conv9" });
  });

  it("installRouteListener updates state on hashchange and invokes the chat callback", () => {
    replaceState({ user: { id: "u", roles: [] } as any });
    const onChat = vi.fn();
    const cleanup = installRouteListener(onChat);
    history.replaceState(null, "", "#/chat/conv-live");
    window.dispatchEvent(new Event("hashchange"));
    expect(readState().view).toBe("chat");
    expect(onChat).toHaveBeenCalledWith("conv-live");

    cleanup();
    onChat.mockClear();
    history.replaceState(null, "", "#/chat/conv-after-cleanup");
    window.dispatchEvent(new Event("hashchange"));
    expect(onChat).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* knowledge.ts                                                        */
/* ------------------------------------------------------------------ */

describe("recordKnowledgeViaAvatar", () => {
  const request = { id: "req1", question: "배포 절차는?", askerName: "지수" } as any;

  beforeEach(() => {
    localStorage.clear();
  });

  it("requires a logged-in avatar", async () => {
    const res = await recordKnowledgeViaAvatar(request, "답");
    expect(res).toEqual({ ok: false, error: "로그인이 필요합니다." });
  });

  it("streams the recording turn, persists the conversation id, and titles it", async () => {
    replaceState({ user: { id: "owner1" } as any });
    const calls: string[] = [];
    useFetch((url, init) => {
      calls.push(`${(init as any).method || "GET"} ${url}`);
      if (url === "/api/chat/stream") {
        return sseRes([frame("open", { conversationId: "kc1", runId: "r1" })]);
      }
      if (url.startsWith("/api/conversations/")) return jsonRes({ ok: true });
      return undefined;
    });
    const res = await recordKnowledgeViaAvatar(request, "배포는 이렇게");
    expect(res).toEqual({ ok: true });
    expect(localStorage.getItem("knowledgeRecConv:owner1")).toBe("kc1");
    expect(calls).toContain("PATCH /api/conversations/kc1");
  });

  it("auto-denies an unexpected permission prompt and cancels a question", async () => {
    replaceState({ user: { id: "owner2" } as any });
    const responded: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        return sseRes([
          frame("open", { conversationId: "kc2", runId: "r2" }),
          frame("permission", { requestId: "perm1" }),
          frame("question", { requestId: "q1" }),
        ]);
      }
      if (url === "/api/chat/respond") {
        responded.push(JSON.parse((init as any).body));
        return jsonRes({ ok: true });
      }
      if (url.startsWith("/api/conversations/")) return jsonRes({ ok: true });
      return undefined;
    });
    const res = await recordKnowledgeViaAvatar(request, "내용");
    expect(res.ok).toBe(true);
    expect(responded).toContainEqual(expect.objectContaining({ requestId: "perm1", value: { behavior: "deny" } }));
    expect(responded).toContainEqual(expect.objectContaining({ requestId: "q1", value: { cancelled: true } }));
  });

  it("returns the error carried by an SSE error frame", async () => {
    replaceState({ user: { id: "owner3" } as any });
    useFetch((url) =>
      url === "/api/chat/stream" ? sseRes([frame("error", { error: "기록 실패" })]) : undefined,
    );
    expect(await recordKnowledgeViaAvatar(request, "x")).toEqual({ ok: false, error: "기록 실패" });
  });

  it("maps a 401 and a non-ok stream open to a friendly error", async () => {
    replaceState({ user: { id: "owner4" } as any });
    useFetch(() => sseRes([], 401));
    expect(await recordKnowledgeViaAvatar(request, "x")).toEqual({ ok: false, error: "세션이 만료되었습니다." });

    useFetch(() => ({ ok: false, status: 500, body: null, json: async () => ({ error: "서버 터짐" }) }));
    expect(await recordKnowledgeViaAvatar(request, "x")).toEqual({ ok: false, error: "서버 터짐" });
  });

  it("rejects a concurrent second recording while one is in flight", async () => {
    replaceState({ user: { id: "owner5" } as any });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    useFetch(async (url) => {
      if (url === "/api/chat/stream") {
        await gate;
        return sseRes([frame("open", { conversationId: "kc5", runId: "r5" })]);
      }
      if (url.startsWith("/api/conversations/")) return jsonRes({ ok: true });
      return undefined;
    });
    const first = recordKnowledgeViaAvatar(request, "첫 기록");
    const second = await recordKnowledgeViaAvatar(request, "둘째 기록");
    expect(second.ok).toBe(false);
    expect(second.error).toContain("다른 기록 요청");
    release();
    expect((await first).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* loaders.ts                                                          */
/* ------------------------------------------------------------------ */

describe("loaders", () => {
  it("loadAvatars fetches once, caches, honors force, and clears loading on error", async () => {
    let hits = 0;
    useFetch((url) => {
      if (url === "/api/avatars") {
        hits++;
        return jsonRes({ avatars: [{ id: "a1" }] });
      }
      return undefined;
    });
    const first = await loadAvatars();
    expect(first).toEqual([{ id: "a1" }]);
    expect(readState()).toMatchObject({ avatarsLoaded: true, avatarsLoading: false });
    // Cached: no second network hit, returns [].
    expect(await loadAvatars()).toEqual([]);
    expect(hits).toBe(1);
    // force re-fetches.
    await loadAvatars(true);
    expect(hits).toBe(2);

    useFetch((url) => (url === "/api/avatars" ? jsonRes({}, 500) : undefined));
    await expect(loadAvatars(true)).rejects.toThrow();
    expect(readState().avatarsLoading).toBe(false);
  });

  it("loadConversations routes chat vs routine into the right slice", async () => {
    useFetch((url) => {
      if (url === "/api/conversations") return jsonRes({ conversations: [{ id: "c" }] });
      if (url === "/api/conversations?kind=routine") return jsonRes({ conversations: [{ id: "r" }] });
      return undefined;
    });
    await loadConversations();
    expect(readState().conversations).toEqual([{ id: "c" }]);
    await loadConversations("routine");
    expect(readState().routineConversations).toEqual([{ id: "r" }]);
  });

  it("loadSettingsData fans out to me/plugins/requests", async () => {
    useFetch((url) => {
      if (url === "/api/me") return jsonRes({ user: { id: "u", roles: [] } });
      if (url === "/api/me/plugins") return jsonRes({ plugins: [{ slug: "p" }] });
      if (url === "/api/me/knowledge/requests") return jsonRes({ requests: [{ id: "q" }] });
      return undefined;
    });
    await loadSettingsData();
    const s = readState();
    expect(s.user?.id).toBe("u");
    expect(s.plugins).toEqual([{ slug: "p" }]);
    expect(s.knowledgeRequests).toEqual([{ id: "q" }]);
  });

  it("loadInboxData renders partial success and reports the failing backend", async () => {
    useFetch((url) => {
      if (url === "/api/me/knowledge/requests") return jsonRes({ requests: [{ id: "q", status: "open" }] });
      if (url === "/api/me/notifications") return jsonRes({}, 500); // fails
      if (url === "/api/conversations?kind=routine") return jsonRes({ conversations: [] });
      return undefined;
    });
    const result = await loadInboxData();
    expect(readState().knowledgeRequests).toEqual([{ id: "q", status: "open" }]);
    expect(result.requestsError).toBeNull();
    expect(result.notificationsError).toBeTruthy();
    expect(result.routinesError).toBeNull();
  });

  it("refreshKnowledgeStatus announces only when the open-request count grows", async () => {
    replaceState({ user: { id: "u" } as any });
    useFetch((url) =>
      url === "/api/me/knowledge/requests"
        ? jsonRes({ requests: [{ id: "a", status: "open" }, { id: "b", status: "open" }] })
        : undefined,
    );
    await refreshKnowledgeStatus({ announce: true });
    expect(get(toasts).some((t) => t.message.includes("2건"))).toBe(true);
    toasts.set([]);
    // Same count on the next poll → no new toast.
    await refreshKnowledgeStatus({ announce: true });
    expect(get(toasts)).toHaveLength(0);
  });

  it("refreshNotificationStatus counts unread and keeps state on fetch failure", async () => {
    replaceState({ user: { id: "u" } as any, notifications: [{ id: "old", readAt: "t" } as any] });
    useFetch((url) =>
      url === "/api/me/notifications"
        ? jsonRes({ notifications: [{ id: "n1", readAt: null }, { id: "n2", readAt: null }] })
        : undefined,
    );
    await refreshNotificationStatus({ announce: true });
    expect(readState().notifications).toHaveLength(2);
    expect(get(toasts).some((t) => t.message.includes("2건"))).toBe(true);

    // A transient failure must not clobber the loaded notifications.
    useFetch(() => jsonRes({}, 500));
    await refreshNotificationStatus({ announce: true });
    expect(readState().notifications).toHaveLength(2);
  });

  it("skips refresh entirely when logged out", async () => {
    const fetchFn = useFetch(() => jsonRes({}));
    await refreshKnowledgeStatus({ announce: true });
    await refreshNotificationStatus({ announce: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("startKnowledgeWatch/stopKnowledgeWatch register and tear down the poll + listener", () => {
    const setInterval = vi.spyOn(window, "setInterval");
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    startKnowledgeWatch();
    expect(setInterval).toHaveBeenCalled();
    expect(addListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    stopKnowledgeWatch();
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("loadRoutinesData / loadAdminOverview / loadAdminGroups populate their slices", async () => {
    useFetch((url) => {
      if (url === "/api/me/routines") return jsonRes({ routines: [{ id: "rt" }] });
      if (url === "/api/conversations?kind=routine") return jsonRes({ conversations: [{ id: "rc" }] });
      if (url === "/api/admin/stats") return jsonRes({ stats: { users: 3 } });
      if (url === "/api/admin/system") return jsonRes({ uptime: 1 });
      if (url === "/api/admin/users") return jsonRes({ users: [{ id: "au" }] });
      if (url === "/api/audit") return jsonRes({ events: [{ id: "ev" }] });
      if (url === "/api/admin/groups") return jsonRes({ groups: [{ id: "g" }] });
      return undefined;
    });
    await loadRoutinesData();
    expect(readState().routines).toEqual([{ id: "rt" }]);
    expect(readState().routineConversations).toEqual([{ id: "rc" }]);

    await loadAdminOverview();
    expect(readState()).toMatchObject({
      adminStats: { users: 3 },
      adminSystem: { uptime: 1 },
      adminUsers: [{ id: "au" }],
      audit: [{ id: "ev" }],
    });

    await loadAdminGroups();
    expect(readState().adminGroups).toEqual([{ id: "g" }]);
  });
});

/* ------------------------------------------------------------------ */
/* format.ts                                                           */
/* ------------------------------------------------------------------ */

describe("format helpers", () => {
  it("avatarImageUrl returns a versioned URL only when the user has an image", () => {
    expect(avatarImageUrl(null)).toBeNull();
    expect(avatarImageUrl({ id: "u1" })).toBeNull();
    expect(avatarImageUrl({ id: "a b", hasImage: true }, 48)).toBe("/api/users/a%20b/avatar-image?v=48");
  });

  it("initials takes the first uppercased char of the best available label", () => {
    expect(initials(null)).toBe("?");
    expect(initials({ displayName: "noah" })).toBe("N");
    expect(initials({ username: "  zed" })).toBe("Z");
    expect(initials({ alias: "" })).toBe("?");
  });

  it("hashHue is deterministic and within 0..359; avatarGradient uses the seed", () => {
    expect(hashHue("seed")).toBe(hashHue("seed"));
    expect(hashHue("seed")).toBeGreaterThanOrEqual(0);
    expect(hashHue("seed")).toBeLessThan(360);
    const grad = avatarGradient({ id: "abc" });
    expect(grad).toMatch(/^linear-gradient\(135deg, hsl\(\d+ 58% 52%\), hsl\(\d+ 64% 42%\)\)$/);
    expect(avatarGradient(null)).toContain("linear-gradient");
  });

  it("renderMarkdown sanitizes to HTML and falls back to a <pre> for markup-only input", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("")).toBe("");
    // A tag-only string sanitizes to empty, so it is re-escaped inside <pre>.
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).toContain("<pre>");
    expect(out).not.toContain("<script>");
  });

  it("formatDate returns '' for empty/invalid and a ko-KR label otherwise", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate("not-a-date")).toBe("");
    expect(formatDate("2026-07-06T09:30:00Z")).not.toBe("");
  });

  it("normalizeTags strips markers, dedupes case-insensitively, caps length and count", () => {
    expect(normalizeTags("#alpha, beta beta")).toEqual(["alpha", "beta"]);
    expect(normalizeTags(["#dup", "DUP", "Ok."])).toEqual(["dup", "Ok"]);
    expect(normalizeTags("x".repeat(40))[0]).toHaveLength(30);
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(12);
    expect(normalizeTags(null)).toEqual([]);
  });

  it("repoToHref resolves shorthand + full URLs and rejects junk (server-mirrored)", () => {
    expect(repoToHref(null, "github.com")).toBeNull();
    expect(repoToHref("owner/repo", "")).toBe("https://github.com/owner/repo");
    expect(repoToHref("owner/repo.git", "https://ghe.corp/")).toBe("https://ghe.corp/owner/repo");
    expect(repoToHref("https://x.com/o/r.git", "github.com")).toBe("https://x.com/o/r");
    expect(repoToHref("nonsense", "github.com")).toBeNull();
  });

  it("timeToMinute / minuteToTime round-trip and clamp", () => {
    expect(timeToMinute("09:30")).toBe(570);
    expect(timeToMinute("bad")).toBe(0);
    expect(minuteToTime(570)).toBe("09:30");
    expect(minuteToTime(-5)).toBe("00:00");
    expect(minuteToTime(99999)).toBe("23:59");
    expect(minuteToTime(null)).toBe("00:00");
  });

  it("timeLabel returns '' for empty/invalid and includes the year only when not current", () => {
    expect(timeLabel(null)).toBe("");
    expect(timeLabel("nope")).toBe("");
    const thisYear = new Date().getFullYear();
    expect(timeLabel(`${thisYear}-07-06T09:30:00`)).not.toMatch(/\d{2,}\. \d{2}\. \d{2}\./);
    expect(timeLabel("2001-07-06T09:30:00")).not.toBe("");
  });

  it("formatRoutineSchedule renders interval/weekly/daily variants (server-mirrored)", () => {
    expect(formatRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 180 })).toBe("3시간마다");
    expect(formatRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 45 })).toBe("45분마다");
    expect(formatRoutineSchedule({ scheduleKind: "weekly", daysOfWeek: [5, 1, 3], time: "09:00" })).toBe(
      "매주 월·수·금 09:00 (KST)",
    );
    // Empty days + empty time collapses to the placeholder day and a doubled space (source has no re-collapse).
    expect(formatRoutineSchedule({ scheduleKind: "weekly", daysOfWeek: [], time: "" })).toBe("매주 —  (KST)");
    expect(formatRoutineSchedule({ scheduleKind: "daily", time: "07:00" })).toBe("매일 07:00 (KST)");
  });

  it("routineTitle prefers the name, then a one-line prompt preview, then a placeholder", () => {
    expect(routineTitle({ name: "  Standup " })).toBe("Standup");
    expect(routineTitle({ prompt: "  line one\nline two  " })).toBe("line one line two");
    expect(routineTitle({ prompt: "x".repeat(50) })).toBe(`${"x".repeat(40)}…`);
    expect(routineTitle({})).toBe("(이름 없는 루틴)");
  });

  it("formatTokenCount compacts by magnitude", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(-1)).toBe("0");
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(17500)).toBe("17.5K");
    expect(formatTokenCount(184000)).toBe("184K");
  });
});
