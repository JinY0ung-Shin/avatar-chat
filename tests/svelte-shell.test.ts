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
    render(Shell, {
      props: { user, view: "explore", railCollapsed: true, onRailCollapsedChange },
    });

    const open = screen.getByRole("button", { name: "메뉴 열기" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("rail")?.hasAttribute("aria-hidden")).toBe(false);

    await fireEvent.click(within(document.getElementById("rail")!).getByRole("button", { name: "메뉴 닫기" }));
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(onRailCollapsedChange).not.toHaveBeenCalled();
  });
});
