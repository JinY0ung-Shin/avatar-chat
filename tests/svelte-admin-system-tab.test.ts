// Regression pins for the 관리자 → 시스템 tab's local-state seeding (load()'s
// panelsSeeded latch + dirty-guards in AdminView.svelte):
// 1. The FIRST load must seed the panels even though the reactive dirty flags
//    recompute (empty local state vs fresh server payload → "dirty") before
//    load()'s continuation reads them — the f168116 guards skipped that first
//    seed, leaving hexPolicy = {} so the tab crashed blank on
//    hexPolicy[role.key][tool.name] and the saved model override rendered as
//    an empty input whose save button would DELETE the override.
// 2. A manual 새로고침 must still preserve unsaved edits (f168116's intent).
// The STT card rides the same seeding path, plus its own env-vs-override
// precedence (env values seed the inputs pre-filled; saving promotes them to an
// admin override; clearing the url deletes it).
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminView from "../src/client/src/views/AdminView.svelte";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Mirrors the real deployment shape: HEX_SSH_TOOL_INFOS is always non-empty
// and DEFAULT_HEX_SSH_TOOL_POLICY allows tools, so on first load the saved
// policy key never matches the unseeded (empty) checkbox matrix.
const system = {
  agentRuntime: "claude",
  configuredModel: "claude-opus-4-8",
  modelOverride: "claude-opus-4-8",
  observedModel: null,
  authMode: "api_key",
  readOnlyTools: [],
  confluenceConfigured: false,
  subscriptionConnected: false,
  apiKeyOverride: false,
  modelEnvLocked: false,
  visionDefault: true,
  modelVisionPolicy: {},
  hexSshTools: [
    { name: "ssh-read-lines", label: "원격 파일 읽기", category: "read" },
    { name: "remote-ssh", label: "원격 명령 실행", category: "execute" },
  ],
  hexSshToolPolicy: {
    owner: ["ssh-read-lines", "remote-ssh"],
    trusted: ["ssh-read-lines"],
    colleague: [],
  },
  togglableBuiltinTools: [],
  toolSkillPolicy: { disabledTools: [], disabledSkills: [] },
  skillDiscovery: null,
  signupMode: "open",
  // STT: env-only deployment — no admin override yet.
  sttOverride: null as { url: string; model: string | null; language?: string | null } | null,
  sttEnvUrl: "http://stt.internal:8000/v1",
  sttEnvModel: "Qwen/Qwen3-ASR-1.7B",
  sttEnvLanguage: "ko",
};

let calls: { url: string; method: string; body: string | null }[] = [];
let systemPayload: Record<string, unknown> = system;

// The stt handler mutates systemPayload the way the server would, so the
// loadAdminOverview() that follows a save observes the new state.
function stubAdminFetch(systemOverrides: Record<string, unknown> = {}): void {
  calls = [];
  systemPayload = { ...system, ...systemOverrides };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
      if (url.includes("/api/admin/stats")) return json({ stats: {} });
      if (url.includes("/api/admin/system")) return json({ system: systemPayload });
      if (url.includes("/api/admin/stt")) {
        if (method === "PUT") {
          const sent = JSON.parse(String(init?.body || "{}")) as { url: string; model?: string; language?: string };
          // An omitted key stores as null, the way the server records "inherit".
          const sttOverride = { url: sent.url, model: sent.model ?? null, language: sent.language ?? null };
          systemPayload = { ...systemPayload, sttOverride };
          return json({ sttOverride });
        }
        systemPayload = { ...systemPayload, sttOverride: null };
        return json({ ok: true });
      }
      if (url.includes("/api/admin/users")) return json({ users: [] });
      if (url.includes("/api/audit")) return json({ audit: [] });
      if (url.includes("/api/admin/groups")) return json({ groups: [] });
      if (url.includes("/api/admin/external-agents"))
        return json({ agents: [], configError: null, shadowedManagedIds: [] });
      return json({});
    }),
  );
}

async function openSystemTab(): Promise<void> {
  render(AdminView);
  const sysTab = await screen.findByRole("tab", { name: "시스템" });
  await fireEvent.click(sysTab);
  await screen.findByText("시스템 정보");
}

function sttUrlInput(): HTMLInputElement {
  return screen.getByLabelText("STT 서버 주소") as HTMLInputElement;
}

function sttModelInput(): HTMLInputElement {
  return screen.getByLabelText("STT 모델 이름") as HTMLInputElement;
}

function sttLanguageInput(): HTMLInputElement {
  return screen.getByLabelText("STT 언어") as HTMLInputElement;
}

function sttCalls(): { url: string; method: string; body: string | null }[] {
  return calls.filter((c) => c.url.includes("/api/admin/stt"));
}

describe("admin 시스템 tab seeding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubAdminFetch();
  });

  it("seeds the panels on first load: tab renders, saved policy + model shown", async () => {
    await openSystemTab();

    // hex policy checkboxes reflect the SAVED policy (not an unseeded matrix).
    expect((screen.getByLabelText("소유자 원격 파일 읽기") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("같은 그룹원 원격 명령 실행") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("일반 동료 원격 파일 읽기") as HTMLInputElement).checked).toBe(false);

    // The saved model override seeds the input — an empty input here offers a
    // "기본값 사용" save that would silently delete the stored override.
    const modelInput = screen.getByPlaceholderText("claude-opus-4-8 (비우면 기본값)") as HTMLInputElement;
    expect(modelInput.value).toBe("claude-opus-4-8");
  });

  it("keeps unsaved policy edits across a manual 새로고침", async () => {
    await openSystemTab();

    const colleagueRead = screen.getByLabelText("일반 동료 원격 파일 읽기") as HTMLInputElement;
    await fireEvent.click(colleagueRead);
    expect(colleagueRead.checked).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeTruthy());

    expect((screen.getByLabelText("일반 동료 원격 파일 읽기") as HTMLInputElement).checked).toBe(true);
    // The untouched rows still show server state.
    expect((screen.getByLabelText("소유자 원격 파일 읽기") as HTMLInputElement).checked).toBe(true);
  });
});

describe("admin 시스템 tab STT card", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubAdminFetch();
  });

  it("pre-fills the env endpoint and leaves the model inheriting", async () => {
    await openSystemTab();

    // The env url seeds the input, so saving any edit promotes it to an
    // override instead of starting from a blank card.
    expect(sttUrlInput().value).toBe("http://stt.internal:8000/v1");
    // The env model is a PLACEHOLDER only — a pre-filled value would pin it.
    expect(sttModelInput().value).toBe("");
    expect(sttModelInput().placeholder).toBe("Qwen/Qwen3-ASR-1.7B");
    expect(screen.getByText("환경 변수(STT_URL) 값을 사용 중입니다.")).toBeTruthy();
  });

  it("saves an edited endpoint as an override and re-seeds from the reload", async () => {
    await openSystemTab();

    await fireEvent.input(sttUrlInput(), { target: { value: "http://gpu-01:8000/v1" } });
    expect(screen.getByText("저장하지 않은 변경 사항이 있습니다.")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "STT 저장" }));

    await waitFor(() => expect(sttCalls().length).toBe(1));
    expect(sttCalls()[0].method).toBe("PUT");
    // No `model` key: an empty model input means "inherit the env default".
    expect(JSON.parse(String(sttCalls()[0].body))).toEqual({ url: "http://gpu-01:8000/v1" });

    await waitFor(() => expect(screen.getByText("관리자 설정 적용 중")).toBeTruthy());
    expect(sttUrlInput().value).toBe("http://gpu-01:8000/v1");
    expect(sttModelInput().value).toBe("");

    // Naming a model now pins it into the existing override.
    await fireEvent.input(sttModelInput(), { target: { value: "whisper-large-v3" } });
    await fireEvent.click(screen.getByRole("button", { name: "STT 저장" }));
    await waitFor(() => expect(sttCalls().length).toBe(2));
    expect(JSON.parse(String(sttCalls()[1].body))).toEqual({
      url: "http://gpu-01:8000/v1",
      model: "whisper-large-v3",
    });
    await waitFor(() => expect(sttModelInput().value).toBe("whisper-large-v3"));
  });

  it("deletes the override when the endpoint is cleared", async () => {
    stubAdminFetch({ sttOverride: { url: "http://admin.stt:9000/v1", model: "custom-asr" } });
    await openSystemTab();

    expect(sttUrlInput().value).toBe("http://admin.stt:9000/v1");
    expect(sttModelInput().value).toBe("custom-asr");

    await fireEvent.input(sttUrlInput(), { target: { value: "  " } });
    expect(screen.getByText("저장하면 환경 변수(STT_URL) 값으로 되돌립니다.")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "설정 해제" }));

    await waitFor(() => expect(sttCalls().length).toBe(1));
    expect(sttCalls()[0].method).toBe("DELETE");
    // Falls back to env, which re-seeds the inputs pre-filled again.
    await waitFor(() => expect(sttUrlInput().value).toBe("http://stt.internal:8000/v1"));
    expect(sttModelInput().value).toBe("");
  });

  it("leaves the language inheriting on first load", async () => {
    await openSystemTab();

    // Like the model field: the deployment default is a PLACEHOLDER only, so
    // an untouched card never pins "ko" into the override.
    expect(sttLanguageInput().value).toBe("");
    expect(sttLanguageInput().placeholder).toBe("ko");
  });

  it("lowercases a typed language into the override", async () => {
    await openSystemTab();

    await fireEvent.input(sttLanguageInput(), { target: { value: "EN" } });
    await fireEvent.click(screen.getByRole("button", { name: "STT 저장" }));

    await waitFor(() => expect(sttCalls().length).toBe(1));
    expect(JSON.parse(String(sttCalls()[0].body))).toEqual({
      url: "http://stt.internal:8000/v1",
      language: "en",
    });
    // The reload re-seeds from what was actually stored, not what was typed.
    await waitFor(() => expect(sttLanguageInput().value).toBe("en"));
  });

  it("drops the language key when the field is cleared, keeping the rest of the override", async () => {
    stubAdminFetch({ sttOverride: { url: "http://admin.stt:9000/v1", model: "custom-asr", language: "en" } });
    await openSystemTab();

    expect(sttLanguageInput().value).toBe("en");

    await fireEvent.input(sttLanguageInput(), { target: { value: "" } });
    await fireEvent.click(screen.getByRole("button", { name: "STT 저장" }));

    await waitFor(() => expect(sttCalls().length).toBe(1));
    expect(sttCalls()[0].method).toBe("PUT");
    // No `language` key = inherit the env default; url/model survive untouched.
    expect(JSON.parse(String(sttCalls()[0].body))).toEqual({
      url: "http://admin.stt:9000/v1",
      model: "custom-asr",
    });
    await waitFor(() => expect(sttLanguageInput().value).toBe(""));
    expect(sttLanguageInput().placeholder).toBe("ko");
    expect(sttModelInput().value).toBe("custom-asr");
  });

  it("renders a legacy override that predates the language field", async () => {
    // Overrides stored before this field existed have no `language` key at all.
    stubAdminFetch({ sttOverride: { url: "http://legacy.stt:9000/v1", model: "custom-asr" } });
    await openSystemTab();

    expect(sttUrlInput().value).toBe("http://legacy.stt:9000/v1");
    expect(sttLanguageInput().value).toBe("");
    expect(sttLanguageInput().placeholder).toBe("ko");
    // A missing key reads as "inherit", so the card opens clean, not dirty.
    expect(screen.getByText("관리자 설정 적용 중")).toBeTruthy();
  });

  it("keeps an unsaved STT edit across a manual 새로고침", async () => {
    await openSystemTab();

    await fireEvent.input(sttUrlInput(), { target: { value: "http://typed-but-unsaved:8000/v1" } });
    await fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "새로고침" })).toBeTruthy());

    expect(sttUrlInput().value).toBe("http://typed-but-unsaved:8000/v1");
    expect(sttCalls()).toEqual([]);
  });
});
