// Per-user "has seen onboarding" flag, kept in localStorage like the old
// lifecycle.js onboardingDone()/markOnboardingDone().
const KEY = "noah-onboarded";

export function onboardingDone(userId: string | undefined | null): boolean {
  if (!userId) return true;
  try {
    return localStorage.getItem(`${KEY}-${userId}`) === "1";
  } catch {
    return true;
  }
}

export function markOnboardingDone(userId: string | undefined | null): void {
  if (!userId) return;
  try {
    localStorage.setItem(`${KEY}-${userId}`, "1");
  } catch {
    /* private mode: just won't persist */
  }
}
