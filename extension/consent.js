// Consent page for creating the "Noah" tab group. background.js opens this as
// a popup window when new_tab finds no group; the answer travels back over the
// extension-INTERNAL message channel (web pages only ever reach
// onMessageExternal), and the background closes the window on settle.
//
// The URL shown here is DISPLAY-ONLY (textContent, never markup). Whether it
// may be opened at all was already decided by the origin allowlist before this
// page appeared.

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const rawUrl = params.get("url") || "";

let host = "";
try {
  host = new URL(rawUrl).hostname;
} catch {
  // Unparseable URL: leave the hostname line to its fallback text.
}
document.getElementById("host").textContent = host || "(알 수 없는 주소)";
document.getElementById("url").textContent = rawUrl;

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
