import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Shell from "../src/client/src/components/Shell.svelte";
import { replaceState } from "../src/client/src/lib/state.js";
import type { User } from "../src/client/src/lib/types.js";

const user = {
  id: "owner-1",
  username: "owner",
  displayName: "Owner",
  alias: "",
  bio: "",
  persona: "",
  intro: "",
  hashtags: [],
  hasImage: false,
  visibility: "private",
  roles: [],
  pluginCount: 0,
  gitTokenSet: false,
  gitIdentityName: null,
  gitIdentityEmail: null,
  knowledgeRepo: null,
  knowledgeBranch: null,
  knowledgeSelected: null,
  groupKnowledgeOffDefault: [],
  modelDefault: null,
  effortDefault: null,
  mcpToolGroupsDefault: null,
  secretNames: [],
  shellExposedSecretNames: [],
  sshPublicKey: null,
  groups: [],
  experimentalFeatures: [],
  sharedAccount: false,
  onboardedAt: null,
} satisfies User;

function setDesktopViewport(matches: boolean): void {
  const media = {
    matches,
    media: "(min-width: 861px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => media));
}

beforeEach(() => {
  replaceState({ conversations: [], chatPanes: [], activePaneId: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ conversations: [] }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Shell rail controls", () => {
  it("collapses and reopens the desktop rail through the parent preference callback", async () => {
    setDesktopViewport(true);
    const onRailCollapsedChange = vi.fn();
    const first = render(Shell, {
      props: { user, view: "explore", railCollapsed: false, onRailCollapsedChange },
    });

    await fireEvent.click(screen.getByRole("button", { name: "왼쪽 메뉴 접기" }));
    expect(onRailCollapsedChange).toHaveBeenCalledWith(true);
    first.unmount();

    render(Shell, {
      props: { user, view: "explore", railCollapsed: true, onRailCollapsedChange },
    });
    expect(document.getElementById("rail")?.getAttribute("aria-hidden")).toBe("true");
    await fireEvent.click(screen.getByRole("button", { name: "메뉴 열기" }));
    expect(onRailCollapsedChange).toHaveBeenLastCalledWith(false);
  });

  it("uses the same controls as an open/close drawer on mobile without changing the desktop preference", async () => {
    setDesktopViewport(false);
    const onRailCollapsedChange = vi.fn();
    const onMobileRailOpenChange = vi.fn();
    render(Shell, {
      props: { user, view: "explore", railCollapsed: true, onRailCollapsedChange, onMobileRailOpenChange },
    });

    const open = screen.getByRole("button", { name: "메뉴 열기" });
    const rail = document.getElementById("rail")!;
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(rail.inert).toBe(true);
    expect(document.getElementById("rail-conversation-list")?.hasAttribute("role")).toBe(false);
    await fireEvent.click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(rail.hasAttribute("aria-hidden")).toBe(false);
    expect(rail.inert).toBe(false);
    expect(open.inert).toBe(true);
    expect(onMobileRailOpenChange).toHaveBeenCalledWith(true);

    const close = within(rail).getByRole("button", { name: "메뉴 닫기" });
    await vi.waitFor(() => expect(document.activeElement).toBe(close));
    await fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(rail.contains(document.activeElement)).toBe(true);

    await fireEvent.keyDown(window, { key: "Escape" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(rail.inert).toBe(true);
    expect(open.inert).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(open));
    expect(onRailCollapsedChange).not.toHaveBeenCalled();
    expect(onMobileRailOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("makes conversation search reversible and gives repeated row actions contextual names", async () => {
    setDesktopViewport(true);
    const conversations = [
      {
        id: "conv-alpha",
        title: "Alpha 계획",
        avatarDisplayName: "Noah",
        updatedAt: "2026-07-13T12:00:00.000Z",
        isRoutine: false,
      },
      {
        id: "conv-beta",
        title: "Beta 점검",
        avatarDisplayName: "Noah",
        updatedAt: "2026-07-13T11:00:00.000Z",
        isRoutine: false,
      },
    ];
    replaceState({ conversations: conversations as any });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ conversations }),
      })),
    );

    render(Shell, { props: { user, view: "explore" } });
    await screen.findByRole("button", { name: "대화 열기: Alpha 계획" });

    const search = screen.getByRole("searchbox", { name: "대화 검색" }) as HTMLInputElement;
    await fireEvent.input(search, { target: { value: "alpha" } });
    expect(document.getElementById("rail-conversation-status")?.textContent).toContain("검색 결과 1개");
    expect(screen.queryByRole("button", { name: "대화 열기: Beta 점검" })).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "대화 검색어 지우기" }));
    expect(search.value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole("button", { name: "분할 대화에 추가: Alpha 계획" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "대화 이름 바꾸기: Alpha 계획" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "대화 삭제: Alpha 계획" })).toBeTruthy();
  });
});
