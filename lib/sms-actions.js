// What happens when Mondo texts an answer back. The Twilio webhook lands here
// (api/admin.js -> do=sms-inbound). Only the owner's own number is accepted.
import { pendingIds, getAsk, closeAsk, digits, plain, smsConfigured } from './sms.js';
import { assignTicketToSite, cancelTicket, markTicketDone, retryTicket, revisionsStatus } from './revisions.js';
import { runAutoTick } from './tick.js';
import { store } from './store.js';

function parse(body) {
  const t = String(body || '').trim().toLowerCase();
  const m = t.match(/^(yes|yep|yeah|y|ok|okay|sure|no|nope|n|done|retry|skip|status|help|stop)\b[\s#:]*(\d+)?/);
  if (!m) return { cmd: null };
  const word = m[1];
  const cmd = /^(yes|yep|yeah|y|ok|okay|sure)$/.test(word) ? 'yes' : /^(no|nope|n)$/.test(word) ? 'no' : word;
  return { cmd, id: m[2] ? Number(m[2]) : null };
}

export async function handleInbound({ from, body }) {
  if (!smsConfigured()) return '';
  if (digits(from) !== digits(process.env.OWNER_PHONE)) return ''; // never answer strangers
  const { cmd, id } = parse(body);
  if (!cmd || cmd === 'help') return 'Reply YES / NO / DONE / RETRY / SKIP to the latest question, add a number to answer an older one (YES 7), or STATUS.';
  if (cmd === 'stop') return ''; // Twilio handles STOP/opt-out itself

  if (cmd === 'status') {
    const st = await revisionsStatus().catch(() => ({ tickets: [] }));
    const open = (st.tickets || []).filter((t) => !['done', 'cancelled'].includes(t.status));
    const last = Number(await store.get('auto:lastTick').catch(() => 0)) || 0;
    const pend = (await pendingIds()).length;
    return plain(`Open revisions: ${open.length}. Automation last ran ${last ? Math.round((Date.now() - last) / 60000) + ' min ago' : 'never'}. Waiting on you: ${pend}.`);
  }

  const ids = await pendingIds();
  const targetId = id || ids[ids.length - 1];
  const ask = targetId ? await getAsk(targetId) : null;
  if (!ask || ask.status !== 'pending') return 'Nothing waiting on an answer right now.';
  const p = ask.payload || {};

  let reply;
  try {
    if (ask.kind === 'unknown-sender') {
      if (cmd === 'yes') {
        const r = await assignTicketToSite(p.ticketId, p.slug);
        reply = r.ok ? 'Done. I replied to them, queued the change, and I will remember that address.' : `Could not do that: ${r.error}`;
      } else if (cmd === 'no' || cmd === 'skip') {
        await cancelTicket(p.ticketId);
        reply = 'Ignored. No reply sent.';
      }
    } else if (ask.kind === 'blocked-revision') {
      if (cmd === 'done') {
        const r = await markTicketDone(p.ticketId);
        reply = r.ok ? 'Marked done. The client has been emailed that it is live.' : `Could not do that: ${r.error}`;
      } else if (cmd === 'retry' || cmd === 'yes') {
        const r = await retryTicket(p.ticketId);
        reply = r.ok ? 'Queued for another try.' : `Could not do that: ${r.error}`;
      } else if (cmd === 'skip' || cmd === 'no') {
        await cancelTicket(p.ticketId);
        reply = 'Dropped it.';
      }
    } else if (ask.kind === 'run-now') {
      if (cmd === 'yes') {
        const r = await runAutoTick();
        reply = `Ran it. ${r.agent ? `Worked on ${r.agent.slug}: ${r.agent.action}.` : 'Nothing was due.'}`;
      } else {
        reply = 'Okay, leaving it.';
      }
    }
  } catch (e) {
    reply = `That failed: ${String(e.message || e).slice(0, 80)}`;
  }
  if (!reply) return `That does not fit question #${ask.id}. ${ask.kind === 'blocked-revision' ? 'Try DONE, RETRY or SKIP.' : 'Try YES or NO.'}`;
  await closeAsk(ask.id);
  return plain(reply);
}
