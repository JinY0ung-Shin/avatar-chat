import { describe, expect, it } from "vitest";
import { repoToHref } from "../src/client/src/lib/format.js";

describe("repoToHref", () => {
  it("returns null for null/empty/whitespace repo", () => {
    expect(repoToHref(null, "github.com")).toBeNull();
    expect(repoToHref("", "github.com")).toBeNull();
    expect(repoToHref("   ", "github.com")).toBeNull();
  });

  it("builds an href from owner/repo shorthand against the given host", () => {
    expect(repoToHref("owner/repo", "github.example.com")).toBe(
      "https://github.example.com/owner/repo",
    );
  });

  it("defaults to github.com when the host is empty", () => {
    expect(repoToHref("owner/repo", "")).toBe("https://github.com/owner/repo");
  });

  it("normalizes a host given with protocol and trailing slash", () => {
    expect(repoToHref("owner/repo", "https://ghe.corp/")).toBe(
      "https://ghe.corp/owner/repo",
    );
  });

  it("returns a full https URL as-is except for a trailing .git", () => {
    expect(repoToHref("https://github.com/owner/repo", "github.com")).toBe(
      "https://github.com/owner/repo",
    );
    expect(repoToHref("https://github.com/owner/repo.git", "github.com")).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("strips a trailing .git from owner/repo shorthand in the built URL", () => {
    expect(repoToHref("owner/repo.git", "github.example.com")).toBe(
      "https://github.example.com/owner/repo",
    );
  });

  it("returns null for a value that is neither a URL nor owner/repo shorthand", () => {
    expect(repoToHref("just-a-word", "github.com")).toBeNull();
    expect(repoToHref("a/b/c with spaces", "github.com")).toBeNull();
  });
});
