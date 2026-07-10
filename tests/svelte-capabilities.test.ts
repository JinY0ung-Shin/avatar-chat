import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CapabilitiesPanel from "../src/client/src/components/CapabilitiesPanel.svelte";
import type { AvatarDetail } from "../src/client/src/lib/types.js";

const avatar = {
  id: "avatar-1",
  username: "avatar",
  displayName: "빈 아바타",
  alias: "",
  bio: "",
  hashtags: [],
  hasImage: false,
  pluginCount: 0,
  visibility: "private",
  updatedAt: null,
  persona: "",
  intro: "",
  isOwn: true,
  elevated: true,
  plugins: [],
} satisfies AvatarDetail;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ skills: [] }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CapabilitiesPanel", () => {
  it("auto-collapses an empty desktop panel but lets the user reopen and persist it", async () => {
    const { container } = render(CapabilitiesPanel, { props: { avatar } });
    const panel = container.querySelector<HTMLElement>(".cap-panel")!;

    await vi.waitFor(() => expect(panel.classList.contains("collapsed")).toBe(true));
    await fireEvent.click(screen.getByRole("button", { name: "역량 패널 펼치기" }));

    expect(panel.classList.contains("collapsed")).toBe(false);
    expect(localStorage.getItem("capPanelCollapsed")).toBe("0");
  });

  it("keeps a panel with an introduction expanded when no preference is stored", async () => {
    const { container } = render(CapabilitiesPanel, {
      props: { avatar: { ...avatar, intro: "제가 할 수 있는 일을 소개합니다." } },
    });
    const panel = container.querySelector<HTMLElement>(".cap-panel")!;

    await vi.waitFor(() => expect(screen.getByText("사용 가능한 스킬이 없습니다.")).toBeTruthy());
    expect(panel.classList.contains("collapsed")).toBe(false);
  });

  it("re-evaluates automatic collapse when the active avatar changes", async () => {
    const { container, rerender } = render(CapabilitiesPanel, { props: { avatar } });
    const panel = container.querySelector<HTMLElement>(".cap-panel")!;

    await vi.waitFor(() => expect(panel.classList.contains("collapsed")).toBe(true));
    await rerender({ avatar: { ...avatar, id: "avatar-2", intro: "새 아바타의 역량 소개" } });

    await vi.waitFor(() => expect(panel.classList.contains("collapsed")).toBe(false));
  });
});
