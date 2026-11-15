export type Suspect = {
  id: string;
  name: string;
  role: string;
  portrait: string;
  voice: string;
  public_bio: string;
  opening: string;
  questions: string[];
};
export type Note = { id: string; text: string; source: string };
export type CallLog = { id: string; name: string; role: string; time: string };
export type CaseState = {
  visited: string[];
  evidence: string[];
  notes: Note[];
  log: CallLog[];
  crossed: boolean;
  guessed: boolean;
};
export type Link = {
  from: string;
  to: string;
  label: string;
  revealed_by: string;
};
export type CaseData = {
  id: string;
  number: string;
  title: string;
  briefing: string;
  opening_letter: {
    sender: string;
    role: string;
    subject: string;
    paragraphs: string[];
  };
  amount: number;
  date: string;
  victim_business: { name: string };
  suspects: Suspect[];
  evidence_catalog: CatalogEntry[];
  location?: string;
  tagline?: string;
  board?: {
    caption: string;
    note: { stamp: string; amount: string; caption: string };
  };
  missing_person?: { name: string; role: string; portrait: string; note: string };
  cross_pair?: string[];
  cases?: CaseSummary[];
  links: Link[];
  mode: "demo" | "live";
  audio: {
    provider: "gemini" | "qwen" | "kokoro" | "browser";
    configured: boolean;
    enabled: boolean;
    model: string;
    timeout_ms?: number;
  };
  data_source: string;
  state: CaseState;
};
export type CaseSummary = {
  id: string;
  number: string;
  title: string;
  tagline: string;
};
/** How a found piece of evidence is pinned on the board. */
export type EvidenceCard =
  | {
      kind: "table";
      topline: string;
      title: string;
      subheading: string;
      rows: string[][];
      total: string;
      total_label?: string;
      label: string;
    }
  | { kind: "sticky"; heading: string; quote: string; by: string; label: string };
export type CatalogEntry = {
  id: string;
  title: string;
  type: string;
  card?: EvidenceCard;
};
export type Evidence = {
  number?: string;
  source?: string;
  period?: string;
  annotation?: string;
  log?: { time: string; device: string; event: string; flagged?: boolean }[];
  id: string;
  title: string;
  type: string;
  summary: string;
  statement?: string;
  witness?: string;
  provenance?: string;
  notice?: string;
  business?: string;
  transactions?: {
    id: string;
    date: string;
    display_time: string;
    merchant: string;
    amount: number;
    status: string;
    flagged?: boolean;
  }[];
};
export type Reveal = {
  guilty_id: string;
  truth_timeline: { t: string; title: string; event: string }[];
  cliffhanger: string;
  next_mission: { title: string; description: string };
  transactions: { date: string; amount: number; display_time?: string }[];
};
export type Message = { role: "user" | "suspect"; text: string };
