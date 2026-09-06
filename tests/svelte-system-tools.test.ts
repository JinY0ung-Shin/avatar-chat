import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminGroupRow from "../src/client/src/components/AdminGroupRow.svelte";
import { replaceState } from "../src/client/src/lib/state.js";
import type { AdminGroupSummary } from "../src/server/types.js";

describe("mandatory system group in the admin policy editor", () => {
  beforeEach(() => {
    replaceState({ adminUsers: [] });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ members: [] }) })));
  });

  it("shows an old empty policy as system-only without making the form dirty", async () => {
    const group = { id: "g", name: "Team", description: "", allowedMcpToolGroups: [], memberCount: 0, adminCount: 0, avatarSharing: true } as unknown as AdminGroupSummary;
    const view = render(AdminGroupRow, { props: { group, reload: vi.fn() } });
    await fireEvent.click(view.getByRole("button", { name: "Team 그룹 관리 열기" }));
    const system = await view.findByRole("checkbox", { name: "시스템 · 항상 사용" }) as HTMLInputElement;
    expect(system.checked).toBe(true);
    expect(system.disabled).toBe(true);
    const save = view.getByRole("button", { name: "정책 저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(view.getByText(/선택 가능한 도구 묶음이 모두 차단됩니다/)).toBeTruthy();
    const web = view.getByRole("checkbox", { name: "웹 읽기" }) as HTMLInputElement;
    await fireEvent.click(web);
    await waitFor(() => expect(save.disabled).toBe(false));
    await fireEvent.click(save);
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls;
      const write = calls.find(([url]) => String(url).endsWith("/tool-policy"));
      expect(write).toBeDefined();
      expect(JSON.parse(String(write![1]?.body))).toEqual({ allowed: ["web", "system"] });
    });
  });
});
