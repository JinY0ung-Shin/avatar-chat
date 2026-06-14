// Auto-split from chat.js — submodule: slash commands + menu. Behavior-preserving relocation only.
import { el, state } from "../core.js";
import { activePane } from "./panes.js";
import { newChat } from "./composer.js";
import { submitMessage } from "./stream.js";

/* ============================================================ Slash commands */
const SLASH_COMMANDS = [
  {
    name: "new",
    title: "새 대화",
    description: "현재 아바타와 새 대화를 바로 시작합니다.",
    action: (pane) => newChat(pane),
  },
  {
    name: "summarize",
    title: "요약",
    description: "지금까지의 대화를 요약합니다.",
    prompt: () => "지금까지의 대화를 핵심 결정사항, 해야 할 일, 열린 질문으로 나눠 요약해줘.",
  },
  {
    name: "learn",
    title: "세션 학습",
    description: "이번 대화에서 재사용할 지식을 추려 저장하게 합니다.",
    ownerOnly: true,
    // Expanded on the SERVER (LEARN_SLASH_PROMPT in app.ts): the bubble shows the
    // literal "/learn" and the model receives the full instruction. No client
    // prompt() — the long instruction never appears in the user's message.
    serverExpand: true,
  },
  {
    name: "remember",
    title: "지식 저장",
    argsLabel: "내용",
    description: "뒤에 쓴 내용을 내 지식 저장소에 기록하게 합니다.",
    ownerOnly: true,
    requiresArgs: true,
    prompt: (args) =>
      `다음 내용을 내 지식 저장소에 기록해서 앞으로 같은 질문에 답할 수 있게 해줘.\n\n${args}`,
  },
  {
    name: "routine",
    title: "루틴 만들기",
    argsLabel: "작업",
    description: "작업 내용을 받아 매일 실행할 루틴 생성을 요청합니다.",
    ownerOnly: true,
    requiresArgs: true,
    prompt: (args) =>
      `다음 작업을 정기적으로 실행하는 루틴을 만들어줘. 실행 시각(KST 기준)이 아래에 적혀 있으면 그대로 쓰고, 없으면 먼저 물어봐줘.\n\n${args}`,
  },
  {
    name: "find",
    title: "아바타 찾기",
    argsLabel: "요청",
    description: "요청에 맞는 팀원 아바타를 찾아 추천하게 합니다.",
    requiresArgs: true,
    prompt: (args) =>
      `이 요청에 더 적합한 팀원 아바타가 있는지 찾아보고 추천해줘.\n\n${args}`,
  },
];

function slashCommandsForPane(pane) {
  const ownsAvatar = pane?.avatar?.id && pane.avatar.id === state.user?.id;
  return SLASH_COMMANDS.filter((cmd) => !cmd.ownerOnly || ownsAvatar);
}

function slashQueryForText(text) {
  if (typeof text !== "string" || text.startsWith("//")) return null;
  const match = /^\/([A-Za-z0-9_-]*)$/.exec(text);
  return match ? match[1].toLowerCase() : null;
}

function matchingSlashCommands(pane, query) {
  const q = (query || "").toLowerCase();
  return slashCommandsForPane(pane).filter((cmd) => {
    if (!q) return true;
    return [cmd.name, cmd.title, cmd.description, cmd.argsLabel || ""].some((value) => value.toLowerCase().includes(q));
  });
}

export function resolveTypedSlashCommand(pane, message) {
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(message);
  if (!match || message.startsWith("//")) return null;
  const name = match[1].toLowerCase();
  const command = slashCommandsForPane(pane).find((cmd) => cmd.name === name);
  if (!command) return null;
  return { command, args: (match[2] || "").trim() };
}

export function slashPrompt(command, args = "") {
  return command.prompt ? command.prompt(args) : "";
}

export function hideSlashMenu(pane = activePane()) {
  const pdom = pane?.dom;
  if (!pdom?.slashMenu) return;
  pdom.slashMenu.hidden = true;
  pdom.slashMenu.replaceChildren();
  pdom.slashMatches = [];
  pdom.slashIndex = 0;
  pdom.textarea?.removeAttribute("aria-controls");
  pdom.textarea?.removeAttribute("aria-activedescendant");
  pdom.textarea?.setAttribute("aria-expanded", "false");
}

// Tab-completion: drop the command's canonical text into the box WITHOUT running
// it. Used by Tab and when a command still needs arguments.
function completeSlashCommand(pane, command) {
  const pdom = pane?.dom;
  if (!pdom?.textarea) return;
  pdom.textarea.value = `/${command.name}${command.requiresArgs ? " " : ""}`;
  pdom.textarea.dispatchEvent(new Event("input"));
  pdom.textarea.focus();
  const end = pdom.textarea.value.length;
  pdom.textarea.setSelectionRange(end, end);
}

// The user PICKED this command (click or Enter): run it if it's ready, or park
// the cursor in the argument slot if it still needs input. A bare no-arg command
// like /learn used to only refill the box here — and the resulting `input` event
// reopened the menu, so Enter could never send it. Now it submits.
export function applySlashCommand(pane, command, args = "") {
  const pdom = pane?.dom;
  if (!pdom?.textarea) return;
  hideSlashMenu(pane);
  if (command.action) {
    pdom.textarea.value = "";
    pdom.textarea.dispatchEvent(new Event("input"));
    command.action(pane, args);
    return;
  }
  // Needs arguments the user hasn't typed yet: complete the name and wait.
  if (command.requiresArgs && !args) {
    completeSlashCommand(pane, command);
    return;
  }
  // Ready to run (no args needed, or args already supplied): normalize the box
  // to the canonical command and submit — submitMessage expands the prompt.
  pdom.textarea.value = `/${command.name}${args ? ` ${args}` : ""}`;
  pdom.textarea.dispatchEvent(new Event("input"));
  submitMessage(pane);
}

export function renderSlashMenu(pane) {
  const pdom = pane?.dom;
  if (!pdom?.textarea || !pdom?.slashMenu) return;
  const query = slashQueryForText(pdom.textarea.value);
  if (query === null || pane.streaming) {
    hideSlashMenu(pane);
    return;
  }
  const matches = matchingSlashCommands(pane, query);
  if (!matches.length) {
    hideSlashMenu(pane);
    return;
  }
  pdom.slashMatches = matches;
  pdom.slashIndex = Math.min(pdom.slashIndex || 0, matches.length - 1);
  const activeId = `${pdom.slashMenu.id}-option-${pdom.slashIndex}`;
  pdom.textarea.setAttribute("aria-controls", pdom.slashMenu.id);
  pdom.textarea.setAttribute("aria-expanded", "true");
  pdom.textarea.setAttribute("aria-activedescendant", activeId);
  pdom.slashMenu.hidden = false;
  pdom.slashMenu.replaceChildren(
    el("div", { class: "slash-menu-head", text: "슬래시 명령" }),
    ...matches.map((cmd, i) => {
      const row = el("button", {
        id: `${pdom.slashMenu.id}-option-${i}`,
        class: `slash-option ${i === pdom.slashIndex ? "active" : ""}`,
        type: "button",
        role: "option",
        "aria-selected": i === pdom.slashIndex ? "true" : "false",
        onclick: () => applySlashCommand(pane, cmd),
      }, [
        el("span", {
          class: "slash-option-command",
          text: `/${cmd.name}${cmd.argsLabel ? ` ${cmd.argsLabel}` : ""}`,
        }),
        el("span", { class: "slash-option-main" }, [
          el("strong", { text: cmd.title }),
          el("span", { text: cmd.description }),
        ]),
      ]);
      row.addEventListener("mousedown", (event) => event.preventDefault());
      return row;
    }),
  );
  const activeOption = document.getElementById(activeId);
  if (activeOption) requestAnimationFrame(() => activeOption.scrollIntoView({ block: "nearest" }));
}

export function handleSlashMenuKeydown(pane, event) {
  const pdom = pane?.dom;
  if (!pdom?.slashMenu || pdom.slashMenu.hidden) return false;
  const matches = pdom.slashMatches || [];
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    if (matches.length) {
      const current = pdom.slashIndex || 0;
      if (event.key === "Home") pdom.slashIndex = 0;
      else if (event.key === "End") pdom.slashIndex = matches.length - 1;
      else {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        pdom.slashIndex = (current + delta + matches.length) % matches.length;
      }
      renderSlashMenu(pane);
    }
    return true;
  }
  if (event.key === "Enter") {
    if (!matches.length) return false;
    event.preventDefault();
    applySlashCommand(pane, matches[pdom.slashIndex || 0]);
    return true;
  }
  if (event.key === "Tab") {
    if (!matches.length) return false;
    event.preventDefault();
    completeSlashCommand(pane, matches[pdom.slashIndex || 0]);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hideSlashMenu(pane);
    return true;
  }
  return false;
}
