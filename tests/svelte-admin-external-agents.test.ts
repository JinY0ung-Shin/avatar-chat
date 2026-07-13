import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminExternalAgentModal from "../src/client/src/components/AdminExternalAgentModal.svelte";
import AdminExternalAgentsPanel from "../src/client/src/components/AdminExternalAgentsPanel.svelte";
import type {
  AdminExternalAgent,
  AdminGroupSummary,
} from "../src/client/src/lib/types.js";

const group = {
  id: "group-1",
  name: "연구팀",
  description: "",
  knowledgeRepo: null,
  memberCount: 3,
  adminCount: 1,
} as AdminGroupSummary;

function managedAgent(
  overrides: Partial<AdminExternalAgent> = {},
): AdminExternalAgent {
  return {
    id: "research",
    displayName: "Research Agent",
    alias: "리서처",
    bio: "외부 조사 아바타",
    persona: "공개 페르소나",
    intro: "무엇을 조사할까요?",
    hashtags: ["research"],
    endpoint: "https://gateway.example/v1/agents/messages",
    agent: "claude",
    enabled: true,
    model: "sonnet",
    system: "private system",
    visibleToGroupIds: [group.id],
    source: "managed",
    apiKeySet: true,
    conversationCount: 2,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("external avatar admin UI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads independently, marks env rows read-only, and opens the create editor", async () => {
    const env = managedAgent({
      id: "environment",
      displayName: "Environment Agent",
      source: "environment",
      visibleToGroupIds: undefined,
      conversationCount: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ agents: [env, managedAgent()], configError: null, shadowedManagedIds: [] }),
      ),
    );

    let finishGroupRefresh: (() => void) | undefined;
    const reloadGroups = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishGroupRefresh = resolve;
        }),
    );
    render(AdminExternalAgentsPanel, {
      props: { active: true, groups: [group], reloadGroups },
    });

    const environmentName = await screen.findByText("Environment Agent");
    const environmentRow = environmentName.closest("article");
    expect(environmentRow).toBeTruthy();
    expect(within(environmentRow!).getByText("환경 변수")).toBeTruthy();
    expect(within(environmentRow!).queryByRole("button", { name: "편집" })).toBeNull();
    expect(within(environmentRow!).queryByRole("button", { name: "삭제" })).toBeNull();
    expect(within(environmentRow!).getByRole("button", { name: "인증·모델 확인" })).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(reloadGroups).toHaveBeenCalledOnce());
    expect(
      (screen.getByRole("button", { name: "새로고침 중…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    finishGroupRefresh?.();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "새로고침" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );

    await fireEvent.click(screen.getByRole("button", { name: /추가/ }));
    const dialog = screen.getByRole("dialog", { name: "외부 아바타 추가" });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText(/stateless.*Gateway/)).toBeTruthy();
    const idInput = within(dialog).getByPlaceholderText("research-agent");
    const endpointInput = within(dialog).getByPlaceholderText(
      "https://gateway.example/v1/agents/messages",
    );
    expect(idInput.getAttribute("aria-invalid")).toBe("false");
    expect(endpointInput.getAttribute("aria-invalid")).toBe("false");
    await fireEvent.input(
      within(dialog).getByPlaceholderText("Research Agent"),
      { target: { value: "새 외부 아바타" } },
    );
    expect(idInput.getAttribute("aria-invalid")).toBe("false");
    expect(endpointInput.getAttribute("aria-invalid")).toBe("false");
  });

  it("sends an explicit key replacement and selected group without exposing the old key", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return json({ agent: managedAgent() });
      }),
    );
    render(AdminExternalAgentModal, {
      props: { agent: managedAgent(), groups: [group] },
    });

    expect(screen.queryByDisplayValue(/private-api/)).toBeNull();
    await fireEvent.click(screen.getByRole("radio", { name: "새 키 등록" }));
    await fireEvent.input(screen.getByLabelText("Gateway API 키"), {
      target: { value: "new-gateway-secret" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe("/api/admin/external-agents/research");
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.agent).toMatchObject({
      id: "research",
      visibleToGroupIds: [group.id],
      apiKeyMode: "set",
      apiKey: "new-gateway-secret",
    });
    expect(JSON.stringify(body)).not.toContain("old-gateway-secret");
  });

  it("uses the safe gateway check and surfaces a model-list warning", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return json({
          ok: true,
          latencyMs: 42,
          modelsCount: 2,
          modelAvailable: false,
        });
      }),
    );
    render(AdminExternalAgentModal, {
      props: { agent: managedAgent(), groups: [group] },
    });

    await fireEvent.click(screen.getByRole("button", { name: "인증·모델 확인" }));
    expect(await screen.findByText(/모델이 Claude 모델 목록에 없습니다/)).toBeTruthy();
    expect(calls[0]).toMatchObject({
      url: "/api/admin/external-agents/test",
      body: {
        storedId: "research",
        agent: expect.objectContaining({ apiKeyMode: "keep" }),
      },
    });

    await fireEvent.input(screen.getByLabelText("모델"), {
      target: { value: "opus" },
    });
    await waitFor(() =>
      expect(
        screen.getByText(/연결 설정이 변경되었습니다.*다시 확인/),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/모델이 Claude 모델 목록에 없습니다/)).toBeNull();
  });

  it("serializes Svelte number bindings for advanced timeouts", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return json({
          ok: true,
          latencyMs: 12,
          modelsCount: 1,
          modelAvailable: true,
        });
      }),
    );
    render(AdminExternalAgentModal, {
      props: { agent: managedAgent(), groups: [group] },
    });

    await fireEvent.click(screen.getByText("고급 시간 제한"));
    const connectTimeoutInput = screen.getByLabelText("연결 (초)");
    await fireEvent.input(connectTimeoutInput, {
      target: { value: "0" },
    });
    expect(connectTimeoutInput.getAttribute("aria-invalid")).toBe("true");
    expect(
      (screen.getByRole("button", { name: "인증·모델 확인" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await fireEvent.input(connectTimeoutInput, {
      target: { value: "25" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "인증·모델 확인" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      url: "/api/admin/external-agents/test",
      body: {
        storedId: "research",
        agent: expect.objectContaining({ connectTimeoutSeconds: 25 }),
      },
    });
  });

  it("shows a recovery-only empty state for an unreadable registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ agents: [], configError: "decrypt_failed", shadowedManagedIds: [] }),
      ),
    );
    render(AdminExternalAgentsPanel, { props: { active: true, groups: [] } });

    expect(await screen.findByText("저장된 설정을 복구해야 합니다.")).toBeTruthy();
    expect(screen.queryByText(/첫 외부 아바타를 추가/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: /추가/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("clears a stored key only through the explicit clear mode", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return json({ agent: managedAgent({ apiKeySet: false }) });
      }),
    );
    render(AdminExternalAgentModal, {
      props: {
        agent: managedAgent({ conversationCount: 0 }),
        groups: [group],
      },
    });

    await fireEvent.input(
      screen.getByPlaceholderText("https://gateway.example/v1/agents/messages"),
      {
        target: { value: "https://other-gateway.example/v1/agents/messages" },
      },
    );
    expect(
      await screen.findByText(/endpoint가 바뀌면 기존 키를 새 주소로 전달하지 않습니다/),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "변경 저장" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await fireEvent.click(screen.getByRole("radio", { name: "저장된 키 삭제" }));
    await fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.agent.apiKeyMode).toBe("clear");
    expect(body.agent).not.toHaveProperty("apiKey");
  });
});
