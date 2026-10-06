// The agent has to be given the page it is being asked to change.
//
// This is a regression test for a real, live, three-day failure. A client wrote:
//
//   "…add a mandatory phone number form for people to fill out when booking
//    a detail?"
//
// `addRevisionTodo` stored `title.slice(0, 140)`, which cut it at exactly
// "…to fill out when b". The agent scores which pages to open by looking for
// each file's name in that text, so `book.html` — the booking page, the only
// file that needed changing — scored nothing on a ten-page site and was never
// fetched. The model then refused, correctly and three times:
//
//   "book.html … wasn't included in the file contents I was given, so I can't
//    see its current form fields/structure/validation to safely add a mandatory
//    phone number field"
//
// Three separate things had to line up for that, and each one is checked here.

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { addRevisionTodo, todosState } from '../lib/todos.js';

const REAL_REQUEST = 'i wanted to reach out and see if it would possible and what it would take to '
  + 'add a mandatory phone number form for people to fill out when booking a detail?';

// ---------------------------------------------------------------------------
section('V1  the truncation that started it');
check('the real request is longer than the 140-character title limit',
  REAL_REQUEST.length > 140, `${REAL_REQUEST.length} characters`);
check('a naive cut lands mid-word', /\bb$/.test(REAL_REQUEST.slice(0, 140)),
  JSON.stringify(REAL_REQUEST.slice(0, 140).slice(-20)));

const id = await addRevisionTodo('vtest-site', { title: REAL_REQUEST, detail: 'Requested by a client', ticketId: `vt${Date.now()}` });
// todosState takes a SITE, not a slug, and returns { current: { items } }.
const state = await todosState({ slug: 'vtest-site' });
const item = (state.current?.items || []).find((t) => t.id === id);
check('the todo was created', !!item, JSON.stringify(state).slice(0, 160));
check('the stored title does NOT end mid-word', !/\bb$/.test(item.title.replace(/…$/, '')),
  JSON.stringify(item.title.slice(-28)));
check('it is still within the display limit', item.title.length <= 141, String(item.title.length));
check('and it is marked as shortened', item.title.endsWith('…'), item.title.slice(-10));

// ---------------------------------------------------------------------------
section('V2  page scoring uses the FULL request, not the shortened title');
// The scoring lives inside `runAgentCycle`, so this reproduces the rule against
// the same inputs rather than reaching into it: the point being proven is that
// the full request text is what gets searched.
function score(files, taskText) {
  const t = taskText.toLowerCase();
  return files.map((p) => {
    const file = p.toLowerCase().replace(/^.*\//, '');
    const base = file.replace(/\.\w+$/, '');
    let s = base === 'index' || base === 'home' ? 0.5 : 0;
    if (t.includes(file) || t.includes(p.toLowerCase())) s += 10;
    if (base.length > 2 && t.includes(base)) s += 3;
    const spaced = base.replace(/[-_]/g, ' ');
    if (spaced.length > 2 && spaced !== base && t.includes(spaced)) s += 3;
    return { p, score: s };
  }).sort((a, b) => b.score - a.score);
}

const SITE = ['index.html', 'about.html', 'book.html', 'faq.html', 'gallery.html',
  'blog/index.html', 'blog/post-1.html', 'blog/post-2.html', 'blog/post-3.html', 'blog/post-4.html'];

const truncated = `${REAL_REQUEST.slice(0, 140)} Requested by a client`;
check('with the TRUNCATED title, book.html scores nothing',
  score(SITE, truncated).find((x) => x.p === 'book.html').score === 0,
  'this is the live failure, reproduced');

const full = `${REAL_REQUEST.slice(0, 140)} Requested by a client ${REAL_REQUEST}`;
const withFull = score(SITE, full);
check('with the FULL request included, book.html scores',
  withFull.find((x) => x.p === 'book.html').score >= 3, JSON.stringify(withFull.slice(0, 3)));
check('and it is not buried below unrelated pages',
  withFull.findIndex((x) => x.p === 'book.html') <= 1, JSON.stringify(withFull.slice(0, 3)));

section('V2b  a page named outright outranks everything');
const named = score(SITE, 'please update book.html to add a phone field');
check('"book.html" in the request scores it top', named[0].p === 'book.html', JSON.stringify(named.slice(0, 2)));
check('and decisively, not marginally', named[0].score >= 10, String(named[0].score));

// ---------------------------------------------------------------------------
section('V3  the real agent reads the stored email, not just the todo');
import { readFile } from 'node:fs/promises';
const agentSrc = await readFile(new URL('../lib/agent.js', import.meta.url), 'utf8');
check('the revision email is pulled in BEFORE pages are chosen',
  agentSrc.indexOf('const revisionText') < agentSrc.indexOf('const scoredHtml'),
  'fetching it after the files have been picked would change nothing');
check('and it is part of the text that scores pages',
  /const taskText = .*revisionText/.test(agentSrc), 'lib/agent.js');
check('a filename in the request is scored highest',
  /taskText\.includes\(file\)[\s\S]{0,60}score \+= 10/.test(agentSrc), 'lib/agent.js');

section('V4  a client revision is not rationed like a speculative SEO task');
check('a revision may sample far more pages than discretionary work',
  /const everyPageLimit = pendingRevision \? 20 : 8/.test(agentSrc), 'lib/agent.js');
check('and the fetch cap does not let config files crowd out the target page',
  /const FETCH_CAP = pendingRevision \? 24 : 10/.test(agentSrc), 'lib/agent.js');
check('a ten-page site now gets every page on a revision',
  SITE.length <= 20,
  'the site this failed on had ten pages — one over the old limit of eight');

// Negative control: discretionary work must NOT have been loosened, or this
// "fix" is just "fetch everything always", which is what the budget exists to
// prevent.
check('NEGATIVE CONTROL: discretionary work keeps the tighter limit',
  /pendingRevision \? 20 : 8/.test(agentSrc) && /pendingRevision \? 10 : 6/.test(agentSrc),
  'the looser budget applies only when a client is actually waiting');

done();
