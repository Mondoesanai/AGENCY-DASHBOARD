// A revision that names two pages and changes one is not finished.
//
// R21.4. This is the defect behind a real, twice-repeated failure: the agent
// patches one page, writes a commit message describing the whole request, and
// `shipFiles` honestly records the single file it touched. Nothing ever compared
// the request against that list, so a half-done revision arrived at verification
// claiming to be whole and relied on a model noticing.
//
// Angie's email is the fixture, verbatim in shape: "HOME PAGE UPDATES ...
// SERVICES PAGE UPDATES". index.html shipped. services.html did not, and sat
// wrong on her live site for a day.
//
// The check can only HOLD a ticket open, never close one, so a wrong answer
// costs a second look rather than a false "done". That asymmetry is why it is
// allowed to be a blunt string match.

import { check, section, done } from './world.mjs';
import { pagesNamedIn, pagesNamedButNotShipped } from '../lib/revisions.js';

const FILES = ['index.html', 'services.html', 'about.html', 'book.html', 'quiz.html', 'blog/index.html'];

const ANGIE = `Hi Mondoe, Here are the changes I'd like to make:
HOME PAGE UPDATES. Please keep the following sections exactly as they are...
I only want to update one area: Update the "Process" section...
SERVICES PAGE UPDATES. Please update the Services page to show my simplified
offerings: 1. The One More Thing Clarity Package $349 ... 3. Mobile Notary
Services. Please keep this section exactly as it currently appears.`;

// ---------------------------------------------------------------------------
section('N1  the real email, against the real outcome');
const named = pagesNamedIn(ANGIE, FILES);
check('it finds the Home page', named.includes('index.html'), named.join(','));
check('and the Services page', named.includes('services.html'), named.join(','));
check('and nothing else', named.length === 2, named.join(','));

const missed = pagesNamedButNotShipped(ANGIE, FILES, ['index.html']);
check('shipping only index.html leaves Services outstanding',
  missed.length === 1 && missed[0] === 'services.html', missed.join(','));
check('shipping BOTH leaves nothing outstanding',
  pagesNamedButNotShipped(ANGIE, FILES, ['index.html', 'services.html']).length === 0,
  'the normal case has to stay silent, or every finished ticket is held open');

section('N1b  case and path do not matter');
check('different case still matches',
  pagesNamedButNotShipped(ANGIE, FILES, ['Index.HTML', 'SERVICES.html']).length === 0);

// ---------------------------------------------------------------------------
section('N2  it does not invent work');
// A false "you missed a page" holds finished work open, so silence is the
// default whenever it is unsure.
check('prose that merely uses the word services names nothing',
  pagesNamedIn('we provide services to families across Plano', FILES).length === 0);
check('nor does "about" in a sentence',
  pagesNamedIn('tell me about the pricing', FILES).length === 0);
check('nor an empty request', pagesNamedIn('', FILES).length === 0);
check('nor a page the repo does not have',
  pagesNamedIn('please update the careers page', FILES).length === 0,
  'naming a file that does not exist is not a missed page');
check('no repo listing means no claims at all',
  pagesNamedIn(ANGIE, []).length === 0,
  'without the file list it cannot map a word to a file, so it says nothing');

section('N2b  the wordings people actually use');
for (const [phrase, want] of [
  ['please update the services page', 'services.html'],
  ['change the Services Page please', 'services.html'],
  ['update services.html', 'services.html'],
  ['the home page needs a new hero', 'index.html'],
  ['on the homepage tab', 'index.html'],
  ['the booking page', 'book.html'],
]) {
  const got = pagesNamedIn(phrase, FILES);
  check(`"${phrase}" -> ${want}`, got.includes(want), got.join(',') || '(none)');
}

// ---------------------------------------------------------------------------
section('N3  it is wired into the sweep, before the model is asked');
import { readFile } from 'node:fs/promises';
const src = await readFile(new URL('../lib/revisions.js', import.meta.url), 'utf8');
const checkAt = src.indexOf('pagesNamedButNotShipped(requestText');
const verifyAt = src.indexOf('const verify = await verifyShippedFix(site, t).catch');
check('the check exists in the sweep', checkAt > 0);
check('and runs BEFORE the model verification', checkAt < verifyAt,
  'it is deterministic and free; asking a model first wastes a call to learn the same thing');
check('a miss holds the ticket rather than closing it',
  /missed\.length[\s\S]{0,700}applyTransition\(t, \{ type: 'rejected'/.test(src));
check('and tells the owner which page was skipped',
  /the request also names \$\{words\}/.test(src), 'lib/revisions.js');
check('the whole check is wrapped, so it cannot break the sweep',
  /try \{[\s\S]{0,2000}pagesNamedButNotShipped[\s\S]{0,1600}\} catch/.test(src));
check('it never runs when nothing shipped',
  /\(t\.shipFiles \|\| \[\]\)\.length/.test(src),
  'a ticket with no ship log has nothing to compare and is not this check\'s business');

done();
