/**
 * Bounded storage for search and fetch results.
 *
 * A fetched page easily exceeds what belongs in a model's context, so a tool
 * returns a preview plus a `responseId`; `get_search_content` then reads
 * slices or finds passages. Records live in memory for one hour, which is the
 * span of a single piece of research.
 */

const TTL_MS = 60 * 60 * 1000;
const MAX_RECORDS = 128;

export interface StoredUrl {
  url: string;
  title?: string;
  content: string;
  error?: string;
  mime?: string;
  status?: number;
}

export interface StoredQuery {
  query: string;
  answer: string;
  sources: { url: string; title: string; snippet?: string }[];
}

export interface StoredRecord {
  id: string;
  type: "search" | "fetch";
  timestamp: number;
  urls?: StoredUrl[];
  queries?: StoredQuery[];
}

const records = new Map<string, StoredRecord>();

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function prune(now: number): void {
  for (const [id, record] of records) {
    if (now - record.timestamp >= TTL_MS) records.delete(id);
  }
  // Map iteration is insertion-ordered, so the oldest entries go first.
  while (records.size > MAX_RECORDS) {
    const oldest = records.keys().next();
    if (oldest.done) break;
    records.delete(oldest.value);
  }
}

export function store(record: Omit<StoredRecord, "id" | "timestamp">): string {
  const now = Date.now();
  const id = generateId();
  records.set(id, { ...record, id, timestamp: now });
  prune(now);
  return id;
}

export function getRecord(id: string): StoredRecord | undefined {
  const record = records.get(id);
  if (!record) return undefined;
  if (Date.now() - record.timestamp >= TTL_MS) {
    records.delete(id);
    return undefined;
  }
  return record;
}

/** Exported for tests; a session never needs to clear storage by hand. */
export function clearRecords(): void {
  records.clear();
}

export interface Slice {
  text: string;
  offset: number;
  returnedChars: number;
  nextOffset?: number;
  contentLength: number;
}

export function sliceContent(content: string, offset = 0, limit = 25_000): Slice {
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (offset > content.length) throw new Error(`offset ${offset} exceeds content length ${content.length}`);
  const end = Math.min(offset + limit, content.length);
  const text = content.slice(offset, end);
  return {
    text,
    offset,
    returnedChars: text.length,
    nextOffset: end < content.length ? end : undefined,
    contentLength: content.length,
  };
}

export type FindMode = "exact" | "case-insensitive" | "fuzzy";

export interface Match {
  text: string;
  offset: number;
}

/** Collapse runs of whitespace so a wrapped phrase still matches. */
function fuzzyNormalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

const CONTEXT = 200;
const MAX_MATCHES = 20;

export function findContent(content: string, terms: string[], mode: FindMode = "case-insensitive"): Match[] {
  const matches: Match[] = [];
  // Fuzzy search runs on a normalised copy, so offsets are reported against it.
  const haystack = mode === "exact" ? content : mode === "case-insensitive" ? content.toLowerCase() : fuzzyNormalize(content);
  const source = mode === "fuzzy" ? fuzzyNormalize(content) : content;
  for (const term of terms) {
    const needle = mode === "exact" ? term : mode === "case-insensitive" ? term.toLowerCase() : fuzzyNormalize(term);
    if (!needle) continue;
    let from = 0;
    while (matches.length < MAX_MATCHES) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const start = Math.max(0, at - CONTEXT);
      const end = Math.min(source.length, at + needle.length + CONTEXT);
      matches.push({ text: source.slice(start, end), offset: at });
      from = at + needle.length;
    }
  }
  return matches;
}
