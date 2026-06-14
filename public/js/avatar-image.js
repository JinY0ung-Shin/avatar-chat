// Auto-split from app.js — module: avatar-image. Behavior-preserving relocation only.
import { el } from "./core.js";


/* ============================================================ Avatar image */
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360;
  return h;
}
function paintGenerated(wrap, person) {
  const seed = person.id || person.username || person.displayName || "a";
  const h = hashHue(seed);
  wrap.style.background = `linear-gradient(135deg, hsl(${h} 58% 52%), hsl(${(h + 48) % 360} 64% 42%))`;
  wrap.style.color = "#fff";
  wrap.textContent = (person.displayName || person.username || "?").trim().charAt(0).toUpperCase();
}
// `alt: ""` marks the image decorative (when the name is adjacent visible
// text) — the wrap is then aria-hidden so generated-initial avatars don't
// announce a stray letter either.
export function avatarNode(person, size = 40, { alt } = {}) {
  const wrap = el("div", { class: "avatar-img", style: `--av-size:${size}px` });
  if (alt === "") wrap.setAttribute("aria-hidden", "true");
  if (person?.hasImage && person.id) {
    const img = el("img", { src: `/api/users/${person.id}/avatar-image`, alt: alt ?? (person.displayName || person.username || "") });
    img.addEventListener("error", () => {
      img.remove();
      paintGenerated(wrap, person);
    });
    wrap.append(img);
  } else {
    paintGenerated(wrap, person);
  }
  return wrap;
}

export async function resizeImage(file, max = 256) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
