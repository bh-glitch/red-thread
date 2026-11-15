import { create } from "zustand";
import type { CaseData, CaseState, CatalogEntry, Link } from "./types";

type Store = {
  data: CaseData | null;
  started: boolean;
  briefingAccepted: boolean;
  acceptBriefing: () => void;
  sidebar: "brief" | "evidence" | "notes" | "log";
  muted: boolean;
  voiceStatus:
    | "idle"
    | "generating"
    | "gemini"
    | "qwen"
    | "kokoro"
    | "browser"
    | "unavailable";
  voiceNotice: string;
  setVoiceStatus: (status: Store["voiceStatus"], notice?: string) => void;
  tags: Record<string, string>;
  setData: (data: CaseData) => void;
  sync: (state: CaseState, links?: Link[], catalog?: CatalogEntry[]) => void;
  start: () => void;
  setSidebar: (sidebar: Store["sidebar"]) => void;
  toggleSound: () => void;
  tag: (id: string, tag: string) => void;
  clear: () => void;
};
export const useGame = create<Store>((set) => ({
  data: null,
  started: false,
  briefingAccepted: false,
  acceptBriefing: () => set({ briefingAccepted: true }),
  sidebar: "brief",
  muted: false,
  voiceStatus: "idle",
  voiceNotice: "",
  setVoiceStatus: (voiceStatus, voiceNotice = "") =>
    set({ voiceStatus, voiceNotice }),
  tags: {},
  setData: (data) => set({ data }),
  sync: (state, links, catalog) =>
    set((s) => ({
      data: s.data
        ? {
            ...s.data,
            state,
            links: links ?? s.data.links,
            evidence_catalog: catalog ?? s.data.evidence_catalog,
          }
        : null,
    })),
  start: () => set({ started: true, briefingAccepted: true }),
  setSidebar: (sidebar) => set({ sidebar }),
  toggleSound: () => set((s) => ({ muted: !s.muted })),
  tag: (id, tag) =>
    set((s) => ({ tags: { ...s.tags, [id]: s.tags[id] === tag ? "" : tag } })),
  clear: () =>
    set({
      started: false,
      briefingAccepted: false,
      sidebar: "brief",
      tags: {},
    }),
}));
