// The Mac footer's live status lines (jobs, goal, chat, waiting), shared so the phone/iPad footer shows the same text.
export const FOOTER_STATUS_QUERY = "pix:footer-status";
/** status: the one-line temporary row above the input (waits, jobs), same text on Mac and phone. */
export interface FooterStatus { work?: string; core?: string; waits?: string; status?: string }
export function footerStatus(pi: { events: { emit(name: string, data: unknown): void } }): FooterStatus {
  const out: FooterStatus = {};
  pi.events.emit(FOOTER_STATUS_QUERY, out);
  return out;
}
