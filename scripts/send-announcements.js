#!/usr/bin/env node
/**
 * Writes to the corresponding authors of the twelve real papers in a day's
 * puzzle — once each, ever.
 *
 *   node scripts/send-announcements.js                 # dry run, prints the mail
 *   node scripts/send-announcements.js --send          # actually sends
 *   node scripts/send-announcements.js --show 1        # full text of one message
 *
 * Required to send:
 *   GMAIL_USER          the account
 *   GMAIL_APP_PASSWORD  an app password, not the account password
 *   MAIL_FROM_NAME      who the message is from
 *   MAIL_POSTAL_ADDRESS a postal address, which CAN-SPAM requires
 *   MAIL_SECRET         signs opt-out links; must match the server's
 * Optional:
 *   PUZZLE_URL          default https://arxiv-connections.fly.dev
 *   MAIL_DIR            where the sent and opt-out lists live
 *
 * Deliberately not automatic. Sending is triggered by running this, so a
 * rebuilt puzzle cannot mail anyone by accident — and the sent log means a
 * second run for the same day sends nothing.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { MailLog, unsubscribeLink } from '../src/mail-list.js';
import { renderAnnouncement, plainTitle } from '../src/mail-template.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const reallySend = args.includes('--send');
const showIndex = args.includes('--show') ? Number(args[args.indexOf('--show') + 1]) : null;

const SITE = process.env.PUZZLE_URL ?? 'https://arxiv-connections.fly.dev';
const MAIL_DIR = process.env.MAIL_DIR ?? path.join(ROOT, 'data', 'mail');
const SECRET = process.env.MAIL_SECRET;

const from = {
  name: process.env.MAIL_FROM_NAME ?? 'arXiv Connections',
  address: process.env.GMAIL_USER,
  postalAddress: process.env.MAIL_POSTAL_ADDRESS ?? '',
};

function requireEnv() {
  const missing = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'MAIL_SECRET', 'MAIL_POSTAL_ADDRESS']
    .filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Cannot send without: ${missing.join(', ')}`);
    process.exit(2);
  }
}

/** The twelve real papers of the day, each with the group it came from. */
async function recipients() {
  const puzzle = await (await fetch(`${SITE}/api/puzzle`)).json();
  const papers = puzzle.groups.flatMap((group) =>
    group.papers.filter((p) => !p.fake).map((paper) => ({ paper, group, day: puzzle.day })));
  return { puzzle, papers };
}

const log = new MailLog(MAIL_DIR);

// Addresses come from the extractor, read as JSON so the two steps stay
// separate: nothing is sent from a run that also did the downloading.
const addressesById = new Map();
if (!process.stdin.isTTY) {
  const piped = await new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
  if (piped.trim()) {
    for (const entry of JSON.parse(piped)) {
      const best = entry.addresses?.[0];
      if (best) addressesById.set(entry.id.replace(/v\d+$/, ''), best.address);
    }
  }
}

if (!addressesById.size) {
  console.error('No addresses on stdin. Run the extractor first:\n'
    + '  node scripts/extract-emails.js --json > /tmp/addresses.json\n'
    + '  node scripts/send-announcements.js < /tmp/addresses.json');
  process.exit(2);
}

const { puzzle, papers } = await recipients();
if (reallySend) requireEnv();

const transport = reallySend
  ? nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  })
  : null;

console.log(`Puzzle for ${puzzle.day} — ${papers.length} real papers`);
console.log(reallySend ? 'SENDING\n' : 'DRY RUN (add --send to actually send)\n');

let sent = 0;
let skipped = 0;

for (const [index, { paper, group, day }] of papers.entries()) {
  const id = paper.id.replace(/v\d+$/, '');
  const address = addressesById.get(id);
  const label = `${id}  ${plainTitle(paper.title).slice(0, 56)}`;

  if (!address) { console.log(`  skip  ${label}\n        no address`); skipped++; continue; }

  const permitted = await log.mayContact(address);
  if (!permitted.ok) {
    console.log(`  skip  ${label}\n        ${address} — ${permitted.reason}`);
    skipped++;
    continue;
  }

  const message = renderAnnouncement({
    paper,
    group,
    day,
    from,
    links: { site: SITE, unsubscribe: unsubscribeLink(SITE, address, SECRET ?? 'dry-run') },
  });

  if (showIndex === index) {
    console.log(`\n--- to ${address} ---\nSubject: ${message.subject}\n\n${message.text}\n---\n`);
  }

  if (!reallySend) {
    console.log(`  would send to ${address}`);
    console.log(`        ${message.odds ? `1 in ${message.odds.oneIn} of ${group.poolSize} in ${group.id}` : 'odds unknown'}`);
    sent++;
    continue;
  }

  try {
    await transport.sendMail({
      from: `"${from.name}" <${from.address}>`,
      to: address,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: {
        // Lets a mail client offer one-click opt-out, and marks this as
        // something the recipient can stop.
        'List-Unsubscribe': `<${unsubscribeLink(SITE, address, SECRET)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    await log.markSent(address);      // recorded immediately, so a crash cannot double-send
    console.log(`  sent  ${label}\n        ${address}`);
    sent++;
    await new Promise((r) => setTimeout(r, 2000));
  } catch (error) {
    console.error(`  FAIL  ${label}\n        ${address} — ${error.message}`);
    skipped++;
  }
}

const totals = await log.counts();
console.log(`\n${sent} ${reallySend ? 'sent' : 'would be sent'}, ${skipped} skipped.`);
console.log(`Lifetime: ${totals.sent} addresses written to, ${totals.suppressed} opted out.`);
