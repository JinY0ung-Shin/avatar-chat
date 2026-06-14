import { readState, replaceState } from "./state";

const API_ERROR_KO: Record<string, string> = {
  "Internal server error": "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
  "Authentication required": "로그인이 필요합니다.",
  "Admin access required": "관리자 권한이 필요합니다.",
};

let sessionExpiredHandler: (() => void) | null = null;

export function setSessionExpiredHandler(handler: () => void): void {
  sessionExpiredHandler = handler;
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      credentials: "same-origin",
      signal:
        options.signal ??
        (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined),
      ...options,
    });
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError") {
      throw new Error("요청 시간이 초과되었습니다. 네트워크 상태를 확인해 주세요.");
    }
    if ((err as Error)?.name === "AbortError") throw err;
    throw new Error("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
  }
  if (response.status === 401 && readState().user) {
    sessionExpiredHandler?.();
    throw new Error("세션이 만료되었습니다. 다시 로그인해 주세요.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const raw = typeof body.error === "string" ? body.error.trim() : "";
    throw new Error(API_ERROR_KO[raw] || raw || `서버 오류가 발생했습니다. (코드 ${response.status}) 잠시 후 다시 시도해 주세요.`);
  }
  return body as T;
}

export async function refreshMe(): Promise<void> {
  const { user } = await api<{ user: import("./types").User | null }>("/api/me");
  replaceState({ user });
}
