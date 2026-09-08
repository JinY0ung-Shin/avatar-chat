import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminEgressPanel from "../src/client/src/components/AdminEgressPanel.svelte";

afterEach(() => vi.unstubAllGlobals());
const initial = { configured: true, proxyReady: true, domains: [".blocked.example"], revision: "a".repeat(32), appliedAt: null, appliedBy: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("admin egress panel", () => {
  it("preserves drafts across tabs and only reports success after an applied response", async () => {
    let resolveSave!: (value: Response) => void;
    const fetchMock = vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === "PUT") return await new Promise<Response>((resolve) => { resolveSave = resolve; });
      return json(initial);
    });
    vi.stubGlobal("fetch", fetchMock);
    const component = render(AdminEgressPanel, { active: true });
    await screen.findByText("blocked.example");
    await fireEvent.input(screen.getByLabelText("차단할 도메인"), { target: { value: "new.example" } });
    await fireEvent.click(screen.getByRole("button", { name: "목록에 추가" }));
    await component.rerender({ active: false });
    await component.rerender({ active: true });
    expect(screen.getByText("new.example")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "저장하고 적용" }));
    await waitFor(() => expect(resolveSave).toBeTypeOf("function"));
    expect(screen.queryByText("전체 아바타에 차단 목록을 적용했습니다.")).toBeNull();
    const options = fetchMock.mock.calls.at(-1)?.[1];
    expect(JSON.parse(String(options?.body))).toEqual({ domains: [".blocked.example", ".new.example"], revision: initial.revision });
    resolveSave(json({ ...initial, domains: [".blocked.example", ".new.example"], revision: "b".repeat(32) }));
    await screen.findByText("전체 아바타에 차단 목록을 적용했습니다.");
  });

  it("retains the draft on a conflict and rejects URLs before saving", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => options?.method === "PUT"
      ? json({ error: "다른 관리자가 목록을 변경했습니다. 최신 목록을 불러오세요." }, 409) : json(initial)));
    render(AdminEgressPanel, { active: true });
    await screen.findByText("blocked.example");
    await fireEvent.input(screen.getByLabelText("차단할 도메인"), { target: { value: "https://invalid.example/path" } });
    await fireEvent.click(screen.getByRole("button", { name: "목록에 추가" }));
    expect((await screen.findByRole("alert")).textContent).toContain("URL·IP 대신");
    await fireEvent.input(screen.getByLabelText("차단할 도메인"), { target: { value: "" } });
    await fireEvent.click(screen.getByRole("button", { name: ".blocked.example 삭제" }));
    await fireEvent.click(screen.getByRole("button", { name: "저장하고 적용" }));
    expect((await screen.findByRole("alert")).textContent).toContain("다른 관리자가");
    expect(screen.queryByText("blocked.example")).toBeNull();
  });

  it("explains installation when the deployment has no controller", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...initial, configured: false })));
    render(AdminEgressPanel, { active: true });
    expect((await screen.findByText(/차단 서비스가 연결되어 있지 않습니다/)).textContent).toContain("운영자");
    expect(screen.queryByRole("button", { name: "저장하고 적용" })).toBeNull();
  });
});
