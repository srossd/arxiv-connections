import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deobfuscate, documentFiles, expandGroups, harvest, isPlausibleAddress, rank,
} from '../src/emails.js';

// Every one of these came out of a real run over one day's twelve papers.
test('TeX internals are not addresses', () => {
  for (const notAnAddress of [
    'ver@amsmath.styendcsname',          // \csname ver@amsmath.sty\endcsname
    'currentoptionsubstyle@post.substyle',
    'societysubstyle@post.substyle',
    '1substyle@post.substyle',
    'rtx@automove.endcsname',
    'bibdataoutpre@bibdata.bibdata',
    'size1@ptsize.clo',
  ]) {
    assert.equal(isPlausibleAddress(notAnAddress), false, `should reject ${notAnAddress}`);
  }
});

test('toolchain addresses are not authors', () => {
  for (const tooling of [
    'texsupport@aptaracorp.com',
    'web@superscript.com',
    'revtex4@aps.org',
    'revtex@aps.org',
    'arthur_ogawa@sbcglobal.net',
  ]) {
    assert.equal(isPlausibleAddress(tooling), false, `should reject ${tooling}`);
  }
});

test('real author addresses survive', () => {
  for (const address of [
    'maximilian.pelkner@ipp.mpg.de',
    'rfitzp@utexas.edu',
    'marisa.petrusky@colorado.edu',
    'luca.ferrari@imtlucca.it',
    'mariano.ceccato@univr.it',
    'luca.verderame@unige.it',
    'p.d.forre@uva.nl',
    'hengzhihe@g.ucla.edu',
    'guangcheng@stat.ucla.edu',
    'aram2@andrew.cmu.edu',
    'aramdas@stanford.edu',
    'agus.soenjaya@asc.tuwien.ac.at',
    'stig@chalmers.se',
    'ali.mesforush@alumni.chalmers.se',
  ]) {
    assert.equal(isPlausibleAddress(address), true, `should keep ${address}`);
  }
});

test('class and style files are not read at all', () => {
  // A tar of a paper plus the REVTeX class that ships with it.
  const tar = makeTar([
    ['ms.tex', '\\begin{document}\\email{author@uni.edu}\\end{document}'],
    ['revtex4-2.cls', '% maintained by arthur_ogawa@sbcglobal.net, revtex4@aps.org'],
    ['aps.sty', '% support: texsupport@aptaracorp.com'],
  ]);
  const files = documentFiles(tar);
  assert.deepEqual(files.map((f) => f.name), ['ms.tex'], 'only the document');

  const found = new Map();
  for (const file of files) harvest(file.text, { source: 'tex', weight: 2, found });
  assert.deepEqual(rank(found).map((e) => e.address), ['author@uni.edu']);
});

test('the file holding \\begin{document} is read first', () => {
  const files = documentFiles(makeTar([
    ['intro.tex', 'Some included section.'],
    ['paper.tex', '\\begin{document}\\author{A}\\end{document}'],
  ]));
  assert.equal(files[0].name, 'paper.tex');
  assert.equal(files[0].isMain, true);
});

test('an address next to a correspondence cue outranks a bare one', () => {
  const found = new Map();
  harvest('\\author{A. One}\\thanks{Corresponding author: one@uni.edu}\\author{B. Two} two@uni.edu',
    { source: 'tex', weight: 2, found });
  const ranked = rank(found);
  assert.equal(ranked[0].address, 'one@uni.edu');
  assert.equal(ranked[0].corresponding, true);
  assert.equal(ranked[1].address, 'two@uni.edu');
  assert.equal(ranked[1].corresponding, false);
});

test('obfuscated addresses are recovered', () => {
  assert.match(deobfuscate('alice (at) example (dot) edu'), /alice@example\.edu/);
  assert.match(deobfuscate('bob [at] example [dot] ac [dot] uk'), /bob@example\.ac\.uk/);
  assert.match(deobfuscate('carol at example.edu'), /carol@example\.edu/);

  const found = harvest('Contact: dave (at) phys (dot) ethz (dot) ch', { source: 'tex' });
  assert.deepEqual(rank(found).map((e) => e.address), ['dave@phys.ethz.ch']);
});

test('group shorthand expands to one address per author', () => {
  assert.deepEqual(expandGroups('{alice,bob, carol}@cs.dept.edu'),
    ['alice@cs.dept.edu', 'bob@cs.dept.edu', 'carol@cs.dept.edu']);

  const found = harvest('\\email{{ann,ben}@inf.ed.ac.uk}', { source: 'tex' });
  assert.deepEqual(rank(found).map((e) => e.address).sort(),
    ['ann@inf.ed.ac.uk', 'ben@inf.ed.ac.uk']);
});

test('trailing punctuation is not part of the address', () => {
  const found = harvest('Write to sam@uni.edu, or to kim@uni.edu.', { source: 'tex' });
  assert.deepEqual(rank(found).map((e) => e.address).sort(), ['kim@uni.edu', 'sam@uni.edu']);
});

test('a PDF-only submission yields no document files', () => {
  assert.deepEqual(documentFiles(Buffer.from('%PDF-1.5\nbinary…')), []);
});

/** Builds a tar the way arXiv bundles source, for the tests above. */
function makeTar(entries) {
  const blocks = [];
  for (const [name, content] of entries) {
    const body = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.write('        ', 148, 'ascii');          // checksum, blank while summing
    header.write('0', 156, 'ascii');
    header.write('ustar  \0', 257, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
