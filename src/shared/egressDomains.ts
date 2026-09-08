/** UI convenience + API validation. The isolated controller validates again. */
export function normalizeEgressDomains(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 500) {
    throw new Error("도메인은 최대 500개까지 등록할 수 있습니다.");
  }
  const result = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") throw new Error("도메인 형식이 올바르지 않습니다.");
    const value = raw.trim().toLowerCase().replace(/\.+$/, "").replace(/^\*\./, ".");
    const host = value.replace(/^\./, "");
    if (!host || host.length > 253 || /^[0-9.]+$/.test(host) || host.startsWith("0x") ||
      host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error("URL·IP 대신 도메인을 입력하세요. 예: .example.com (하위 도메인 포함)");
    }
    result.add(value);
  }
  return [...result].filter((value) => ![...result].some((other) =>
    other.startsWith(".") && other !== value &&
    (value.replace(/^\./, "") === other.slice(1) || value.replace(/^\./, "").endsWith(other)),
  )).sort();
}
