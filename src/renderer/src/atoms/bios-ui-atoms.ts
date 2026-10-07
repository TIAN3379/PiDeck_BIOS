import { atom } from "jotai";

/** A UI retry opens the single root confirmation owner; it grants no permissions. */
export const biosOnboardingRequestAtom = atom<{ desktopProjectId: string; nonce: number } | null>(null);
