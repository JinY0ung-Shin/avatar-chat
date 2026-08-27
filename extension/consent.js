// Consent page for the browser bridge. background.js opens this as a popup
// window and the answer travels back over the extension-INTERNAL message channel
// (web pages only ever reach onMessageExternal), and the background closes the
// window on settle.
//
// Two kinds, chosen by the `kind` query param:
//   - default (tab-group creation): new_tab found no Noah group and asks to make
//     one, showing the URL about to open.
//   - kind=cookies (read_cookies): the avatar wants THIS site's cookies —
//     including login session tokens — handed to it and stored in the chat.
//
// The URL/host shown here is DISPLAY-ONLY (textContent, never markup). Whether
// the action may happen at all was already decided (origin allowlist / the
// server) before this page appeared.

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const kind = params.get("kind") || "group";

if (kind === "cookies") {
  const host = params.get("host") || "";
  document.title = "쿠키 접근 허용";
  document.getElementById("title").textContent = "이 사이트의 쿠키를 아바타에게 넘길까요?";
  document.getElementById("lead").textContent =
    "아바타가 현재 탭의 쿠키를 읽으려고 합니다. 허용하면 이 사이트의 쿠키가 — 로그인 세션 " +
    "토큰을 포함해 — 읽혀 아바타에게 전달되고 대화 기록에 저장됩니다. 또한 이 사이트는 이번 " +
    "브라우저 세션 동안 기억되어, 확장 설정에서 취소하거나 브라우저를 닫기 전까지는 같은 사이트에 " +
    "대해 다시 묻지 않습니다.";
  document.getElementById("host").textContent = host || "(알 수 없는 주소)";
  // No full URL line for cookies — the host is what matters, and a path/query
  // could itself carry a token we should not surface.
  document.getElementById("url").textContent = "";
  document.getElementById("hint").textContent =
    "세션 토큰이 노출되면 이 사이트에 로그인한 것과 같은 접근이 가능해집니다. 신뢰하는 작업에만 " +
    "허용하세요. 허용은 이번 세션 동안 이 사이트에 대해 유지되며, 확장 설정에서 언제든 취소할 수 " +
    "있습니다. 20초 안에 응답하지 않으면 이 요청은 만료됩니다.";
  document.getElementById("allow").textContent = "허용";
} else {
  const rawUrl = params.get("url") || "";
  let host = "";
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    // Unparseable URL: leave the hostname line to its fallback text.
  }
  document.getElementById("host").textContent = host || "(알 수 없는 주소)";
  document.getElementById("url").textContent = rawUrl;
}

let answered = false;
function answer(allow) {
  if (answered) return;
  answered = true;
  // The background settles the request and removes this window; the callback
  // close is the fallback for when it already lost track of us.
  chrome.runtime.sendMessage({ type: "noah-group-consent", token, allow }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
}

document.getElementById("allow").addEventListener("click", () => answer(true));
document.getElementById("deny").addEventListener("click", () => answer(false));
