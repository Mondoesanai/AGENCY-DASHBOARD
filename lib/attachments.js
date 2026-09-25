// Reads the files clients attach to revision emails (an events list as a Word
// doc / spreadsheet / PDF / screenshot) and turns them into plain text the
// agent can work from. Office files are zips of XML, so they are opened here
// with node's built-in zlib — no new dependency. PDFs and images are read by
// the model (Claude reads both natively).
import zlib from 'node:zlib';
import { store } from './store.js';
import { markAiMonth } from './aicost.js';

const MONTH = () => new Date().toISOString().slice(0, 7);
const MAX_FILES = 4;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_TEXT_PER_FILE = 12000;

// minimal zip reader: central directory -> { name: Buffer }
export function unzip(buf) {
  const out = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (!/\.(xml|rels)$/i.test(name)) continue;
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const data = buf.slice(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
    try {
      out[name] = method === 0 ? data : zlib.inflateRawSync(data);
    } catch {
      /* skip a damaged entry */
    }
  }
  return out;
}

const unescapeXml = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

function docxText(files) {
  const x = files['word/document.xml']?.toString('utf8') || '';
  return unescapeXml(
    x
      .replace(/<w:tab\s*\/>/g, '\t')
      .replace(/<w:br\s*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, ' | ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function xlsxText(files) {
  const shared = [];
  const ss = files['xl/sharedStrings.xml']?.toString('utf8') || '';
  for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) || []) shared.push(unescapeXml((si.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const sheetNames = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const parts = [];
  for (const n of sheetNames) {
    const rows = [];
    for (const row of files[n].toString('utf8').match(/<row[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const c of row.match(/<c\b[\s\S]*?(?:<\/c>|\/>)/g) || []) {
        const t = (c.match(/\bt="(\w+)"/) || [])[1];
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        const inline = (c.match(/<is>[\s\S]*?<\/is>/) || [])[0];
        if (inline) cells.push(unescapeXml(inline.replace(/<[^>]+>/g, '')));
        else if (v === undefined) continue;
        else cells.push(t === 's' ? shared[Number(v)] ?? '' : unescapeXml(v));
      }
      if (cells.some((x) => String(x).trim())) rows.push(cells.join(' | '));
    }
    if (rows.length) parts.push(`[sheet ${parts.length + 1}]\n${rows.join('\n')}`);
  }
  return parts.join('\n\n');
}

function pptxText(files) {
  const slides = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return slides
    .map((n, i) => `[slide ${i + 1}] ` + unescapeXml((files[n].toString('utf8').match(/<a:t>[\s\S]*?<\/a:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(' ')))
    .join('\n');
}

async function readWithModel(name, mime, buf) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return '';
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  const isPdf = /pdf/i.test(mime) || /\.pdf$/i.test(name);
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: /png|gif|webp/i.test(mime) ? mime.toLowerCase() : 'image/jpeg', data: buf.toString('base64') } };
  const r = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3000,
    messages: [{ role: 'user', content: [block, { type: 'text', text: 'Transcribe ALL the text in this file exactly (names, dates, times, places, prices, links). Keep rows/lists as lines. Output only the text, no commentary.' }] }],
  });
  const usd = ((r.usage?.input_tokens || 0) / 1e6) * 1 + ((r.usage?.output_tokens || 0) / 1e6) * 5;
  const k = `coach:spend:${MONTH()}`;
  const cur = Number(await store.get(k).catch(() => 0)) || 0;
  await store.set(k, String(cur + usd)).catch(() => {});
  await markAiMonth(MONTH()).catch(() => {});
  return (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

// attachments: [{ filename, mimeType, size, fetch: async () => Buffer }]
export async function extractAttachmentText(attachments) {
  const notes = [];
  const chunks = [];
  // skip tiny inline images (email signatures, logos); everything else is worth a look
  const list = (attachments || []).filter((a) => a && a.filename && !(/\.(png|jpe?g|gif)$/i.test(a.filename) && (a.size || 0) < 40000));
  for (const a of list.slice(0, MAX_FILES)) {
    try {
      if ((a.size || 0) > MAX_BYTES) {
        notes.push(`${a.filename}: too large to read automatically`);
        continue;
      }
      const buf = await a.fetch();
      const n = a.filename;
      let text = '';
      if (/\.docx$/i.test(n)) text = docxText(unzip(buf));
      else if (/\.xlsx$/i.test(n)) text = xlsxText(unzip(buf));
      else if (/\.pptx$/i.test(n)) text = pptxText(unzip(buf));
      else if (/\.(txt|csv|md|json|html?|ics|rtf)$/i.test(n) || /^text\//i.test(a.mimeType || '')) text = buf.toString('utf8').replace(/<[^>]+>/g, ' ');
      else if (/\.pdf$/i.test(n) || /pdf/i.test(a.mimeType || '') || /\.(png|jpe?g|webp|gif)$/i.test(n) || /^image\//i.test(a.mimeType || '')) text = await readWithModel(n, a.mimeType || '', buf);
      else if (/\.(doc|xls|ppt)$/i.test(n)) {
        notes.push(`${n}: old Office format (.${n.split('.').pop()}) can't be read automatically — ask for a .docx/.xlsx or PDF`);
        continue;
      } else {
        notes.push(`${n}: file type not supported`);
        continue;
      }
      text = String(text).replace(/\s+\n/g, '\n').trim();
      if (!text) {
        notes.push(`${n}: no readable text found`);
        continue;
      }
      chunks.push(`--- attached file: ${n} ---\n${text.slice(0, MAX_TEXT_PER_FILE)}${text.length > MAX_TEXT_PER_FILE ? '\n[…file continues]' : ''}`);
    } catch (e) {
      notes.push(`${a.filename}: could not be read (${String(e.message || e).slice(0, 80)})`);
    }
  }
  return { text: chunks.join('\n\n'), notes };
}
