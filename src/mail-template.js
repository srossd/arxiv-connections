import { chanceForPaper, formatPercent } from './odds.js';

/**
 * The one message an author gets when their paper appears in a puzzle.
 *
 * Deliberately short, and it carries the things a legitimate one-off message
 * needs: who is writing, why this address was used, what the message is about,
 * and a working way to never hear from us again. The sender's postal address is
 * required by CAN-SPAM and is passed in rather than hard-coded.
 */

const escapeHtml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Titles carry LaTeX; nobody wants `$\eta$` in a subject line. */
export function plainTitle(title) {
  return String(title)
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\$([^$]*)\$/g, '$1')
    .replace(/\\[a-zA-Z]+\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Builds the message for one paper.
 *
 * `paper`   { title, url, id }
 * `group`   { id, name, poolSize }
 * `links`   { site, unsubscribe }
 */
export function renderAnnouncement({ paper, group, day, links, from }) {
  const title = plainTitle(paper.title);
  const odds = chanceForPaper(group.id, group.poolSize);

  // Careful with the arithmetic: three of the category's papers make it in, not
  // twelve, and the twelve are spread across four categories.
  // Ends with its own punctuation, so the sentence that uses it adds none.
  const chance = odds
    ? `one of only 12 papers in the puzzle — about a ${formatPercent(odds.percent)} chance, `
      + `or 1 in ${odds.oneIn}. (${group.name} (${group.id}) was one of the four categories `
      + `drawn, and three of its ${group.poolSize} papers that day made it in.)`
    : 'one of only 12 papers in the puzzle.';

  const subject = `Your paper is in today's arXiv Connections puzzle`;

  const text = [
    `Your paper "${title}" was featured in today's arXiv Connections,`,
    `a daily puzzle built from the papers arXiv announced that morning.`,
    ``,
    `It was ${chance}`,
    ``,
    `You have earned a break after getting new research posted — so here is`,
    `today's puzzle: ${links.site}`,
    ``,
    `Sixteen titles, four arXiv categories. Three papers in each category are`,
    `real. The fourth is a fake, generated from that category's own back`,
    `catalogue. Find the groups, then find the impostors.`,
    ``,
    `— ${from.name}`,
    ``,
    `You are receiving this once, because ${paper.url} lists this address for`,
    `correspondence. It is not a mailing list and there is nothing to unsubscribe`,
    `from, but if you would rather never hear from this project again:`,
    links.unsubscribe,
    ``,
    from.postalAddress,
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f5f2;
  font:16px/1.55 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#14140f">
<div style="max-width:34rem;margin:0 auto;background:#fff;border:1px solid #d9d6cd;
  border-radius:14px;padding:1.75rem">
  <p style="margin:0 0 1rem">Your paper</p>
  <p style="margin:0 0 1rem;font-weight:700;font-size:1.05rem">
    <a href="${escapeHtml(paper.url)}" style="color:#14140f">${escapeHtml(title)}</a>
  </p>
  <p style="margin:0 0 1rem">was featured in today's <strong>arXiv Connections</strong>, a daily
  puzzle built from the papers arXiv announced that morning.</p>
  <p style="margin:0 0 1.25rem">It was ${escapeHtml(chance)}</p>
  <p style="margin:0 0 1.5rem">You have earned a break after getting new research posted:</p>
  <p style="margin:0 0 1.5rem">
    <a href="${escapeHtml(links.site)}" style="display:inline-block;padding:0.7rem 1.3rem;
      border-radius:999px;background:#14140f;color:#fff;text-decoration:none;font-weight:700">
      Play today's arXiv Connections</a>
  </p>
  <p style="margin:0 0 1.5rem;color:#5d5c55;font-size:0.92rem">Sixteen titles, four arXiv
  categories. Three papers in each category are real. The fourth is a fake, generated from that
  category's own back catalogue. Find the groups, then find the impostors.</p>
  <p style="margin:0 0 1.5rem">— ${escapeHtml(from.name)}</p>
  <hr style="border:0;border-top:1px solid #d9d6cd;margin:0 0 1rem">
  <p style="margin:0 0 0.5rem;color:#5d5c55;font-size:0.8rem">You are receiving this once, because
  <a href="${escapeHtml(paper.url)}" style="color:#5d5c55">${escapeHtml(paper.id)}</a> lists this
  address for correspondence. It is not a mailing list, but if you would rather never hear from this
  project again, <a href="${escapeHtml(links.unsubscribe)}" style="color:#5d5c55">opt out here</a>.</p>
  <p style="margin:0;color:#5d5c55;font-size:0.8rem">${escapeHtml(from.postalAddress)}</p>
</div></body></html>`;

  return { subject, text, html, odds };
}
