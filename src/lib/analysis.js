import { kvs } from '@forge/kvs';
import { findSpecPageIds, getChildren, getIssue, getPage } from './atlassian';
import { completeJson } from './llm';
import { hashString, truncate, verifyQuote } from './text';

export const STATUSES = ['covered', 'partial', 'missing', 'contradicted'];
const WEIGHT = { covered: 1, partial: 0.5, missing: 0, contradicted: 0 };

export const analysisKey = (issueKey) => `analysis:${issueKey}`;
export const dismissedKey = (issueKey) => `dismissed:${issueKey}`;

export async function detectSpecs(issueKey) {
  const issue = await getIssue(issueKey, 'app');
  let ids = await findSpecPageIds(issue, 'app');
  let inheritedFrom = null;
  if (!ids.length && issue.parentKey) {
    const parent = await getIssue(issue.parentKey, 'app').catch(() => null);
    if (parent) {
      ids = await findSpecPageIds(parent, 'app');
      if (ids.length) inheritedFrom = parent.key;
    }
  }
  const pages = [];
  for (const id of ids.slice(0, 3)) {
    const p = await getPage(id, 'app').catch(() => null);
    if (p) pages.push({ id: p.id, title: p.title, url: p.url, version: p.version });
  }
  const children = await getChildren(issueKey, 'app').catch(() => []);
  return { pages, inheritedFrom, childCount: children.length };
}

export async function gatherContext(issueKey) {
  const issue = await getIssue(issueKey, 'app');
  let pageIds = await findSpecPageIds(issue, 'app');
  let inheritedFrom = null;
  if (!pageIds.length && issue.parentKey) {
    const parent = await getIssue(issue.parentKey, 'app').catch(() => null);
    if (parent) {
      pageIds = await findSpecPageIds(parent, 'app');
      if (pageIds.length) inheritedFrom = parent.key;
    }
  }
  const pages = [];
  for (const id of pageIds.slice(0, 3)) {
    try {
      pages.push(await getPage(id, 'app'));
    } catch (e) {
      pages.push({ id, error: e.status === 404 || e.status === 403 ? 'not-accessible' : 'error' });
    }
  }
  const children = await getChildren(issueKey, 'app').catch(() => []);
  const readable = pages.filter((p) => !p.error);
  const fingerprint = hashString(JSON.stringify([
    issue.updated,
    children.map((c) => [c.key, c.updated]),
    readable.map((p) => [p.id, p.version]),
  ]));
  return { issue, pages, readable, children, inheritedFrom, fingerprint };
}

const SYSTEM = `You are Driftwise, a meticulous delivery reviewer. You compare a product specification (from Confluence) with the work planned in Jira, and report where they drift apart, so a team can ship with confidence.

Rules:
- Work only from the text you are given. Never invent requirements, issues or facts.
- Every quote you return must be copied character-for-character from the given text (you may shorten with "…" only between whole phrases). Keep quotes under 200 characters.
- A requirement is "covered" when the Jira work clearly includes it, "partial" when it is only partly addressed or lacks a measurable detail the spec states (numbers, limits, states), "missing" when no Jira work addresses it, and "contradicted" when the Jira work says something incompatible with the spec.
- Be precise and conservative: prefer "partial" over "covered" when a specific number, limit or condition in the spec is absent from Jira.
- Suggested acceptance criteria must be testable, one sentence, written in the team's language style, and faithful to the spec.
- Respond with JSON only, no prose before or after.`;

function buildPrompt(ctx) {
  const { issue, readable, children } = ctx;
  const spec = readable
    .map((p) => `### SPEC PAGE "${p.title}" (page ${p.id}, version ${p.version})\n${truncate(p.text, 14000)}`)
    .join('\n\n');
  const mode = issue.isEpic || children.length >= 2 ? 'scope' : 'item';
  const itemText = (i) => `[${i.key}] (${i.type || 'Work item'}, status: ${i.status}) ${i.summary}\n${truncate(i.description || '(no description)', 1800)}`;
  let work = `### JIRA ${issue.isEpic ? 'EPIC' : 'WORK ITEM'}\n${itemText(issue)}`;
  if (issue.comments.length) {
    work += `\nRecent comments:\n${issue.comments.map((c) => `- ${c.author}: ${truncate(c.text, 400)}`).join('\n')}`;
  }
  if (children.length) {
    work += `\n\n### CHILD WORK ITEMS (${children.length})\n${children.map(itemText).join('\n\n')}`;
  }
  const task = mode === 'scope'
    ? `Task: list EVERY distinct requirement in the spec (up to 15, merge trivial ones) and judge each against all the Jira work above. Set "issueKey" to the work item that covers (or contradicts) it, or null.`
    : `Task: this is a single work item. First decide which spec requirements fall within this item's scope (judging from its summary and description). Judge ONLY those (up to 12). Ignore requirements clearly belonging to other work.`;
  const schema = `{
  "summary": "one sentence verdict for a busy engineering lead",
  "requirements": [
    {"id": "R1", "requirement": "short paraphrase (max 15 words)", "specQuote": "exact quote from spec", "status": "covered|partial|missing|contradicted", "issueKey": "KEY-1 or null", "evidenceQuote": "exact quote from Jira text, or empty string", "explanation": "one or two sentences on what matches or differs", "suggestedCriterion": "testable acceptance criterion, empty if covered"}
  ],
  "outOfSpec": [ {"issueKey": "KEY-1", "evidenceQuote": "exact quote from Jira", "explanation": "work that the spec does not ask for or excludes"} ],
  "questions": [ {"specQuote": "exact quote from spec", "question": "the open question the team must answer before shipping"} ]
}`;
  return `${spec}\n\n${work}\n\n${task}\nAlso list up to 5 pieces of Jira work that are outside the spec (scope creep or explicitly out-of-scope items), and up to 4 genuinely ambiguous spec statements.\n\nReturn JSON with exactly this shape:\n${schema}`;
}

function score(requirements, dismissed = []) {
  const counted = requirements.filter((r) => !dismissed.includes(r.fid));
  if (!counted.length) return null;
  const sum = counted.reduce((a, r) => a + (WEIGHT[r.status] ?? 0), 0);
  return Math.round((100 * sum) / counted.length);
}

export function summarise(result, dismissed = []) {
  const reqs = result.requirements || [];
  const counts = Object.fromEntries(STATUSES.map((s) => [s, reqs.filter((r) => r.status === s && !dismissed.includes(r.fid)).length]));
  return {
    counts,
    confidence: score(reqs, dismissed),
    outOfSpec: (result.outOfSpec || []).filter((o) => !dismissed.includes(o.fid)).length,
    questions: (result.questions || []).filter((q) => !dismissed.includes(q.fid)).length,
  };
}

export async function runAnalysis(issueKey) {
  const ctx = await gatherContext(issueKey);
  const base = {
    issueKey,
    fingerprint: ctx.fingerprint,
    analyzedAt: new Date().toISOString(),
    pages: ctx.pages.map(({ text, ...p }) => p),
    inheritedFrom: ctx.inheritedFrom,
    childCount: ctx.children.length,
  };
  if (!ctx.readable.length) {
    const record = { ...base, state: ctx.pages.length ? 'spec-unreadable' : 'no-spec' };
    await kvs.set(analysisKey(issueKey), record);
    return record;
  }
  const { data, model, usd } = await completeJson({ system: SYSTEM, user: buildPrompt(ctx), maxTokens: 6000 });

  const specText = ctx.readable.map((p) => p.text).join('\n');
  const workText = [ctx.issue, ...ctx.children]
    .map((i) => `${i.summary}\n${i.description}`)
    .concat(ctx.issue.comments.map((c) => c.text))
    .join('\n');
  const keys = new Set([ctx.issue.key, ...ctx.children.map((c) => c.key)]);

  const requirements = (data.requirements || [])
    .filter((r) => STATUSES.includes(r.status) && r.requirement)
    .map((r, i) => ({
      fid: `r:${hashString(r.specQuote || r.requirement)}`,
      id: r.id || `R${i + 1}`,
      requirement: r.requirement,
      specQuote: r.specQuote || '',
      specVerified: verifyQuote(r.specQuote, specText),
      status: r.status,
      issueKey: keys.has(r.issueKey) ? r.issueKey : null,
      evidenceQuote: r.evidenceQuote || '',
      evidenceVerified: r.evidenceQuote ? verifyQuote(r.evidenceQuote, workText) : null,
      explanation: r.explanation || '',
      suggestedCriterion: r.status === 'covered' ? '' : (r.suggestedCriterion || ''),
    }));
  const outOfSpec = (data.outOfSpec || []).slice(0, 5).map((o) => ({
    fid: `o:${hashString(o.evidenceQuote || o.explanation)}`,
    issueKey: keys.has(o.issueKey) ? o.issueKey : null,
    evidenceQuote: o.evidenceQuote || '',
    evidenceVerified: verifyQuote(o.evidenceQuote, workText),
    explanation: o.explanation || '',
  }));
  const questions = (data.questions || []).slice(0, 4).map((q) => ({
    fid: `q:${hashString(q.specQuote || q.question)}`,
    specQuote: q.specQuote || '',
    specVerified: verifyQuote(q.specQuote, specText),
    question: q.question || '',
  }));

  const result = { summary: data.summary || '', requirements, outOfSpec, questions };
  const record = { ...base, state: 'done', model, usd, result, summaryText: ctx.issue.summary, projectKey: ctx.issue.projectKey };
  await kvs.set(analysisKey(issueKey), record);
  const pk = `project:${ctx.issue.projectKey}`;
  const idx = (await kvs.get(pk)) || [];
  if (!idx.includes(issueKey)) await kvs.set(pk, [issueKey, ...idx].slice(0, 100));
  for (const p of ctx.readable) {
    const k = `page:${p.id}`;
    const cur = (await kvs.get(k)) || {};
    cur[issueKey] = { confidence: summarise(result).confidence, at: base.analyzedAt, summary: ctx.issue.summary };
    await kvs.set(k, cur);
  }
  return record;
}
