#!/usr/bin/env node
// Build (and cache) today's puzzle without starting the server.
// Handy as a cron job just after 2am Eastern so the first visitor never waits.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PuzzleStore, puzzleDayFor } from '../src/puzzle.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const store = new PuzzleStore(process.env.ARXIV_CACHE_DIR ?? path.join(ROOT, 'cache'));
const day = process.argv[2] ?? puzzleDayFor();

const puzzle = await store.get(day);
console.log(`${puzzle.day} — announced ${puzzle.announcedOn}`);
for (const group of puzzle.groups) {
  console.log(`\n  ${group.id}  ${group.name}`);
  for (const paper of group.papers) console.log(`    · ${paper.title}`);
}
