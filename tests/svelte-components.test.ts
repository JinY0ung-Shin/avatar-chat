// Svelte component tests — run in the vitest "components" project (jsdom +
// @sveltejs/vite-plugin-svelte + @testing-library/svelte; see vitest.config.ts).
// New component tests must be named tests/svelte-*.test.ts: that glob routes
// them to this project, and to tsconfig.client.json for typechecking.
import { fireEvent, render, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ActivityTree from "../src/client/src/components/ActivityTree.svelte";
import RoutineModal from "../src/client/src/components/RoutineModal.svelte";
import Toasts from "../src/client/src/components/Toasts.svelte";
import Toggle from "../src/client/src/components/Toggle.svelte";
import { toasts } from "../src/client/src/lib/state.js";
import type {
  LiveAgentNode,
  LiveTaskRow,
  LiveToolRow,
  RoutineJob,
  Toast,
} from "../src/client/src/lib/types.js";

/* ------------------------------------------------------------------ */
/* Toggle — accessible switch whose visual state follows the SAVE      */
/* ------------------------------------------------------------------ */

describe("Toggle", () => {
  it("renders an accessible switch and flips only after onChange succeeds", async () => {
    const onChange = vi.fn(async (_next: boolean) => {});
    render(Toggle, { props: { on: false, label: "알림 사용", onChange } });

    const sw = screen.getByRole("switch", { name: "알림 사용" });
    expect(sw.getAttribute("aria-checked")).toBe("false");

    await fireEvent.click(sw);

    expect(onChange).toHaveBeenCalledWith(true);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.className).toContain("on");
  });

  it("keeps the previous visual state when the save rejects", async () => {
    const onChange = vi.fn(async () => {
      throw new Error("save failed");
    });
    render(Toggle, { props: { on: true, label: "저장 실패", onChange } });

    const sw = screen.getByRole("switch", { name: "저장 실패" });
    await fireEvent.click(sw);

    expect(onChange).toHaveBeenCalledWith(false);
    expect(sw.getAttribute("aria-checked")).toBe("true"); // still on
  });

  it("locks while a save is in flight and ignores re-clicks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const onChange = vi.fn(() => gate);
    render(Toggle, { props: { on: false, label: "느린 저장", onChange } });

    const sw = screen.getByRole("switch", { name: "느린 저장" }) as HTMLButtonElement;
    await fireEvent.click(sw);
    expect(sw.getAttribute("aria-busy")).toBe("true");
    expect(sw.disabled).toBe(true);

    await fireEvent.click(sw); // busy → ignored
    release();
    await vi.waitFor(() => expect(sw.getAttribute("aria-busy")).toBe("false"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });
});

/* ------------------------------------------------------------------ */
/* RoutineModal — one-time KST date/time schedule builder              */
/* ------------------------------------------------------------------ */

describe("RoutineModal", () => {
  it("offers a one-time date/time schedule and rejects a past slot", async () => {
    render(RoutineModal, { props: { routine: null } });

    const kind = screen.getByRole("combobox", { name: "실행 방식" });
    await fireEvent.change(kind, { target: { value: "once" } });
    const date = screen.getByLabelText("실행 날짜") as HTMLInputElement;
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByLabelText("실행 시각")).toBeTruthy();

    await fireEvent.input(screen.getByLabelText("작업 프롬프트"), {
      target: { value: "출시 상태를 확인해줘" },
    });
    expect((screen.getByRole("button", { name: "루틴 추가" }) as HTMLButtonElement).disabled).toBe(false);

    await fireEvent.input(date, { target: { value: "2000-01-01" } });
    expect(screen.getByText("한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "루틴 추가" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets a completed one-time routine's metadata be edited without re-running it", async () => {
    const routine: RoutineJob = {
      id: "once-1",
      avatarUserId: "owner-1",
      conversationId: "conv-1",
      name: "지난 작업",
      prompt: "한 번 실행",
      scheduleKind: "once",
      minuteOfDay: 9 * 60,
      time: "09:00",
      daysOfWeek: null,
      intervalMinutes: null,
      runDate: "2000-01-01",
      enabled: false,
      nextRunAt: null,
      lastRunAt: "2000-01-01T00:00:00.000Z",
      lastStatus: "success",
      lastError: null,
      completedAt: "2000-01-01T00:00:00.000Z",
      createdAt: "1999-12-01T00:00:00.000Z",
    };
    render(RoutineModal, { props: { routine } });

    expect(screen.queryByRole("button", { name: "지금 실행" })).toBeNull();
    await fireEvent.input(screen.getByLabelText("루틴 이름"), {
      target: { value: "지난 작업 이름 변경" },
    });
    expect((screen.getByRole("button", { name: "변경 저장" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Toasts — store-driven notification stack                            */
/* ------------------------------------------------------------------ */

describe("Toasts", () => {
  beforeEach(() => {
    toasts.set([]);
  });

  it("renders queued toasts with urgency-aware live-region roles", () => {
    const queue: Toast[] = [
      { id: "t1", message: "저장 완료", kind: "info" },
      { id: "t2", message: "연결 끊김", kind: "warn" },
    ];
    toasts.set(queue);
    render(Toasts);

    const info = screen.getByText("저장 완료").closest(".toast")!;
    const warn = screen.getByText("연결 끊김").closest(".toast")!;
    expect(info.getAttribute("role")).toBe("status");
    expect(info.getAttribute("aria-live")).toBe("polite");
    expect(warn.getAttribute("role")).toBe("alert");
    expect(warn.getAttribute("aria-live")).toBe("assertive");
    expect(warn.className).toContain("warn");
  });

  it("runs a toast action then dismisses it; × closes plain toasts", async () => {
    const action = vi.fn();
    toasts.set([
      { id: "a1", message: "삭제했습니다", kind: "warn", actionLabel: "실행 취소", action },
      { id: "p1", message: "그냥 알림", kind: "ok" },
    ]);
    render(Toasts);

    await fireEvent.click(screen.getByRole("button", { name: "실행 취소" }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(get(toasts).map((t) => t.id)).toEqual(["p1"]);
    expect(screen.queryByText("삭제했습니다")).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "알림 닫기" }));
    expect(get(toasts)).toEqual([]);
    expect(screen.queryByText("그냥 알림")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* ActivityTree — recursive agent → task/tool rendering                */
/* ------------------------------------------------------------------ */

describe("ActivityTree", () => {
  const agents: LiveAgentNode[] = [
    { id: "main", parentId: "", label: "", status: "running", isMain: true },
    { id: "sub1", parentId: "main", label: "조사 담당", status: "running", isMain: false },
  ];
  const tools: LiveToolRow[] = [
    { id: "t1", agentId: "sub1", kind: "tool", label: "명령 실행", detail: "ls -la", status: "done" },
  ];
  const tasks: LiveTaskRow[] = [
    { id: "k1", agentId: "sub1", label: "worker", detail: "진행 상황", status: "running" },
    { id: "k2", agentId: "sub1", label: "", status: "done" },
  ];

  it("renders the recursive agent tree with task/tool rows and Korean a11y labels", () => {
    const { container } = render(ActivityTree, {
      props: { agentId: "main", agents, tools, tasks },
    });

    expect(container.querySelector(".agent-node.is-main")).toBeTruthy();
    expect(screen.getByText("조사 담당")).toBeTruthy(); // recursive child rendered

    const named = screen.getByText("worker").closest(".task-row")!;
    expect(named.getAttribute("data-status")).toBe("running");
    expect(named.getAttribute("aria-label")).toBe("태스크 · worker · 진행 중 · 진행 상황");
    expect(named.querySelector(".task-detail")!.textContent).toBe("진행 상황");

    const tool = screen.getByText("명령 실행").closest(".tool-row")!;
    expect(tool.getAttribute("data-status")).toBe("done");
    expect(tool.querySelector(".tool-arg")!.textContent).toBe("ls -la");
  });

  it("omits the task-name span for an unnamed task (the 태스크 badge carries it)", () => {
    const { container } = render(ActivityTree, {
      props: { agentId: "main", agents, tools, tasks },
    });

    const rows = [...container.querySelectorAll(".task-row")];
    expect(rows).toHaveLength(2);
    const unnamed = rows.find((r) => r.getAttribute("aria-label") === "태스크 · 작업 · 완료")!;
    expect(unnamed).toBeTruthy();
    expect(unnamed.querySelector(".task-name")).toBeNull();
  });

  it("lifts kind==='task' tool rows into the owning agent's task list", () => {
    const lifted: LiveToolRow[] = [
      ...tools,
      { id: "bg1", agentId: "main", kind: "task", label: "백그라운드 빌드", status: "running" },
    ];
    const { container } = render(ActivityTree, {
      props: { agentId: "main", agents, tools: lifted, tasks: [] },
    });

    const mainNode = container.querySelector(".agent-node.is-main")!;
    const row = screen.getByText("백그라운드 빌드").closest(".task-row")!;
    expect(mainNode.contains(row)).toBe(true); // rendered as a TASK row, not a tool row
    expect(row.getAttribute("aria-label")).toBe("태스크 · 백그라운드 빌드 · 진행 중");
  });
});
