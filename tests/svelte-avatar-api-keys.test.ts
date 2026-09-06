import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import SettingsAvatarApiKeys from "../src/client/src/components/SettingsAvatarApiKeys.svelte";

afterEach(() => vi.unstubAllGlobals());

it("issues a named key, clears the one-time secret on tab exit, and revokes the key", async () => {
  const key = { id: "key-1", name: "모니터링", prefix: "noah_prefix", createdAt: "2026-09-06T00:00:00Z", lastUsedAt: null };
  const fetchMock = vi.fn(async (_url: unknown, options?: RequestInit) => ({
    ok: true, status: 200,
    json: async () => options?.method === "POST" ? { key, token: "noah_one_time_secret" } : options?.method === "DELETE" ? { ok: true } : { keys: [] },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(SettingsAvatarApiKeys, { props: { active: true } });
  await waitFor(() => expect(screen.getByText("발급된 API 키가 없습니다.")).toBeTruthy());
  await fireEvent.input(screen.getByLabelText("API 키 이름"), { target: { value: "모니터링" } });
  await fireEvent.click(screen.getByRole("button", { name: "API 키 발급" }));
  await waitFor(() => expect((screen.getByLabelText("발급된 API 키") as HTMLInputElement).value).toBe("noah_one_time_secret"));
  expect(fetchMock.mock.calls.some(([, options]) => options?.body === '{"name":"모니터링"}')).toBe(true);
  await view.rerender({ active: false });
  await view.rerender({ active: true });
  expect(screen.queryByLabelText("발급된 API 키")).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "API 키 폐기: 모니터링" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "API 키 폐기: 모니터링" })).toBeNull());
  expect(fetchMock.mock.calls.some(([url, options]) => url === "/api/me/avatar-api-keys/key-1" && options?.method === "DELETE")).toBe(true);
});
