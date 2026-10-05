// The SMS inbox and the follow-up panel, as screens.
//
// Both regressions below were found by driving the real page in a browser, and
// both are the same shape: the screen was technically correct and practically
// useless.
//
//   · "Cannot send." with no reason after it. The module set `error` on its
//     early refusals and `reason` on its later ones; the screen read `reason`.
//   · The typed message vanished when the panel re-rendered, and the screen
//     then said "there is nothing written yet" — a confusing lie about the
//     owner's own input.
import { check, section, done } from './world.mjs';
import {
  renderWaiting, renderConversation, renderSmsStats, wireSmsInbox, DELIVERY_WORD, OWNER_WORD,
} from '../public/sms-inbox.js';
import { renderRelationships, wireRelationships, headline, PATH_WORD } from '../public/relationships.js';
import { compose } from '../lib/sms-send.js';

const conv = (over = {}) => ({
  conversation: {
    messages: [
      { id: 'm1', channel: 'sms', direction: 'outbound', body: 'Hello', at: Date.now() - 7200e3, by: 'owner', state: 'delivered' },
      { id: 'm2', channel: 'sms', direction: 'inbound', body: 'Send it here', at: Date.now() - 3600e3 },
    ],
    ownership: { mode: 'draft-only' },
    paused: { paused: false },
    ...over,
  },
});

// ---------------------------------------------------------------------------
section('U1  a refusal always says why');
let html = renderConversation(conv(), { draft: { ok: false, reason: 'this contact has no SMS permission' } });
check('the refusal is shown', /Cannot send/.test(html));
check('with the reason after it', /no SMS permission/.test(html), html.slice(html.indexOf('Cannot send'), html.indexOf('Cannot send') + 140));

// the exact regression: a refusal that carries `error` rather than `reason`
html = renderConversation(conv(), { draft: { ok: false, error: 'there is nothing written yet' } });
check('a refusal carrying only `error` still shows its reason', /nothing written yet/.test(html),
  html.slice(html.indexOf('Cannot send'), html.indexOf('Cannot send') + 140));

html = renderConversation(conv(), { draft: { ok: false } });
check('a refusal with NEITHER says so rather than rendering blank', /no reason was given/.test(html));

// and the module itself now sets `reason` on every refusal
const empty = await compose({ contact: { id: 'x', phone: { value: '+12145550201' } }, body: '  ' });
check('compose sets a reason on an empty message', !!empty.reason, JSON.stringify(empty));
const noContact = await compose({ contact: null, body: 'hi' });
check('and on a missing contact', !!noContact.reason, JSON.stringify(noContact));

// ---------------------------------------------------------------------------
section('U2  the typed message survives a re-render');
html = renderConversation(conv(), { body: 'half a sentence I was still writing' });
check('what was typed is put back into the box', /half a sentence I was still writing/.test(html));
html = renderConversation(conv(), { body: 'typed', draft: { ok: false, body: 'stale', reason: 'no' } });
check('the live text wins over a stale draft', /">typed</.test(html), html.slice(html.indexOf('textarea'), html.indexOf('textarea') + 120));
html = renderConversation(conv(), { draft: { ok: true, body: 'from the draft', cost: { segments: 1, estimatedCents: 0.79 } } });
check('and the draft is used when nothing newer was typed', /from the draft/.test(html));
check('a message with markup in it is escaped', !/<img/.test(renderConversation(conv(), { body: '<img src=x onerror=alert(1)>' })));

// ---------------------------------------------------------------------------
section('U3  accepted is not delivered, on screen');
check('they are different words', DELIVERY_WORD.accepted !== DELIVERY_WORD.delivered);
check('and accepted names the provider, not the carrier', /provider/i.test(DELIVERY_WORD.accepted), DELIVERY_WORD.accepted);
html = renderConversation({ conversation: { messages: [{ id: 'a', channel: 'sms', direction: 'outbound', body: 'x', at: Date.now(), state: 'accepted' }], ownership: { mode: 'draft-only' }, paused: {} } });
check('an accepted message is NOT shown as delivered', !/>Delivered</.test(html), html.slice(0, 200));
check('it is shown as accepted by the provider', /Accepted by the provider/.test(html));

const stats = renderSmsStats({ sms: { attempted: 10, delivered: 6, deliveryUnknown: 2, failed: 2, estimatedCents: 790 }, previews: { promised: 3, delivered: 1, brokenPromises: 2 } });
check('the report separates delivered from unknown', /6 confirmed delivered/.test(stats) && /2 never confirmed/.test(stats), stats.slice(0, 200));
check('and flags the cost as an estimate', /estimate/i.test(stats));
check('previews still owed are shown', /2 still owed/.test(stats));

// ---------------------------------------------------------------------------
section('U4  who owns the conversation is visible and changeable');
html = renderConversation(conv({ ownership: { mode: 'draft-only' } }));
check('draft-only says nothing goes out until you send', /Nothing goes out until you send/.test(html));
check('and offers take over', /smsTakeOver/.test(html));
html = renderConversation(conv({ ownership: { mode: 'person' } }));
check('taken over says nothing automatic will answer', /Nothing automatic will answer/.test(html));
check('and mentions that queued replies were cancelled', /queued reply was cancelled|was cancelled/i.test(html), html.slice(0, 300));
check('it does NOT offer take over again', !/smsTakeOver/.test(html));
html = renderConversation(conv({ ownership: { mode: 'automatic' } }));
check('automatic warns that replies may go unseen', /without you seeing them/.test(html));

html = renderConversation(conv({ paused: { paused: true, reason: 'they replied on sms' } }));
check('a paused conversation says so', /Paused/.test(html) && /replied on sms/.test(html));

// ---------------------------------------------------------------------------
section('U5  a failed read is never "nobody is waiting"');
const failed = renderWaiting(null, { error: 'the inbox did not answer' });
check('an error renders as an error', /did not answer/.test(failed));
check('and never as an empty inbox', !/Nobody is waiting/.test(failed));
const emptyInbox = renderWaiting({ conversations: [] });
check('a real empty inbox says so', /Nobody is waiting/.test(emptyInbox));
check('and distinguishes itself from a failed read', /not a failed read/.test(emptyInbox));

// ---------------------------------------------------------------------------
section('U6  the follow-up panel shows path, why, next and when');
const relData = {
  followUps: { all: [{
    contactId: 'c1', path: 'follow-up-later',
    why: 'They asked to be contacted Tuesday when you met at Plano Chamber.',
    nextAction: 'send the preview', dueAt: Date.now() - 86400e3,
    interaction: { encounter: 'conversation', notes: 'Owns a flooring company.' },
  }] },
  previews: { tasks: [{ id: 'p1', contactId: 'c1', businessName: 'Hale Flooring', state: 'requested', conversationNotes: 'wants easier quotes' }] },
};
html = renderRelationships(relData);
check('the path is named in plain words', new RegExp(PATH_WORD['follow-up-later']).test(html));
check('the reason is shown', /asked to be contacted Tuesday/.test(html));
check('the next action is shown', /send the preview/.test(html));
check('and when it is due, in words', /overdue/.test(html), html.slice(html.indexOf('When'), html.indexOf('When') + 90));
check('their own note is kept', /flooring company/.test(html));
check('the unbuilt preview is called out', /promised and not built/.test(html));
check('with the reason it cannot be announced', /nothing can tell those people it is ready/i.test(html));

const neverMet = renderRelationships({ followUps: { all: [{ contactId: 'c2', path: 'group-context', why: 'same group', nextAction: 'introduce yourself', dueAt: null, interaction: { encounter: 'shared-group' } }] }, previews: { tasks: [] } });
check('someone never met is flagged on screen', /never met — do not say you did/.test(neverMet));
const didMeet = renderRelationships({ followUps: { all: [{ contactId: 'c3', path: 'gentle-intro', why: 'met', nextAction: 'note', dueAt: null, interaction: { encounter: 'conversation' } }] }, previews: { tasks: [] } });
check('someone you did meet is not', !/never met/.test(didMeet));

check('the panel states that none of these can be cold-campaigned', /cold campaign/i.test(html));
const relErr = renderRelationships(null, { error: 'it did not answer' });
check('a failed read is an error, not an empty list', /did not answer/.test(relErr) && !/Nobody here yet/.test(relErr));

// ---------------------------------------------------------------------------
section('U7  every button has a handler behind it');
const listeners = [];
const root = { addEventListener: (ev, fn) => listeners.push([ev, fn]) };
check('the inbox wires', wireSmsInbox(root, {}) === true);
check('the follow-up panel wires', wireRelationships(root, {}) === true);
check('wiring nothing is survivable', wireSmsInbox(null, {}) === false && wireRelationships(null, {}) === false);

listeners.length = 0;
const calls = [];
wireSmsInbox(root, { open: (id) => calls.push(['open', id]), takeOver: () => calls.push(['takeOver']), mode: (m) => calls.push(['mode', m]), pause: (p) => calls.push(['pause', p]), preview: () => calls.push(['preview']), send: () => calls.push(['send']) });
const fire = (sel, attr, val) => listeners[0][1]({ target: { closest: (s) => (s === sel ? { getAttribute: () => val } : null) } });
fire('[data-conv]', 'data-conv', 'c1');
fire('#smsTakeOver');
fire('[data-mode]', 'data-mode', 'automatic');
fire('[data-pause]', 'data-pause', 'pause');
fire('#smsPreview');
fire('#smsSend');
check('open, take over, mode, pause, check and send all reach a handler', calls.length === 6, JSON.stringify(calls));
check('and carry their argument', calls[0][1] === 'c1' && calls[2][1] === 'automatic');

listeners.length = 0;
const relCalls = [];
wireRelationships(root, { edit: (id) => relCalls.push(['edit', id]), open: (id) => relCalls.push(['open', id]), preview: (t, s) => relCalls.push(['preview', t, s]) });
listeners[0][1]({ target: { closest: (s) => (s === '[data-rel-edit]' ? { getAttribute: () => 'c1' } : null) } });
listeners[0][1]({ target: { closest: (s) => (s === '[data-pv]' ? { getAttribute: (a) => (a === 'data-task' ? 'p1' : 'ready') } : null) } });
check('edit and preview-state reach handlers', relCalls.length === 2, JSON.stringify(relCalls));
check('a click on nothing is survivable', (() => { listeners[0][1]({ target: { closest: () => null } }); return true; })());

done();
