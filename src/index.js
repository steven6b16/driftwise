import Resolver from '@forge/resolver';
import { Queue } from '@forge/events';
import { kvs } from '@forge/kvs';
import {
  addComment, appendAcceptanceCriterion, createFollowUp, getIssue, getPage, linkSpecPage, searchIssues, searchPages,
} from './lib/atlassian';
import { analysisKey, detectSpecs, dismissedKey, gatherContext, runAnalysis, summarise } from './lib/analysis';
import { MONTHLY_BUDGET_USD, getSpend } from './lib/llm';
import { seedDemo } from './lib/seed';
import { suggestSpecs } from './lib/graph';

const queue = new Queue({ key: 'driftwise-analysis' });
const jobKey = (k) => `job:${k}`;
const appliedKey = (k) => `applied:${k}`;
const resolver = new Resolver();

const issueKeyOf = (context) => context?.extension?.issue?.key;

// Every user-facing call first reads the issue as the user, so people only see
// analyses of work they are allowed to see.
async function assertCanView(issueKey) {
  if (!issueKey) throw new Error('No work item in context');
  return getIssue(issueKey, 'user');
}

async function queueAnalysis(issueKey) {
  const spend = await getSpend();
  if (spend.usd >= MONTHLY_BUDGET_USD) {
    await kvs.set(jobKey(issueKey), { state: 'error', message: 'This site has used its monthly AI budget for Driftwise.', at: Date.now() });
    return;
  }
  await kvs.set(jobKey(issueKey), { state: 'queued', at: Date.now() });
  await queue.push([{ body: { issueKey } }]);
}

resolver.define('getState', async ({ context }) => {
  const issueKey = issueKeyOf(context);
  const issue = await assertCanView(issueKey);
  const [record, job, dismissed, applied, created] = await Promise.all([
    kvs.get(analysisKey(issueKey)),
    kvs.get(jobKey(issueKey)),
    kvs.get(dismissedKey(issueKey)),
    kvs.get(appliedKey(issueKey)),
    kvs.get(`created:${issueKey}`),
  ]);
  let stale = false;
  let currentPages = null;
  if (record && (!job || job.state === 'done' || job.state === 'error')) {
    try {
      const ctx = await gatherContext(issueKey);
      stale = ctx.fingerprint !== record.fingerprint;
      currentPages = ctx.pages.map(({ text, ...p }) => p);
    } catch (e) {
      stale = false;
    }
  }
  let detected = null;
  let suggestions = null;
  if (!record || record.state === 'no-spec') {
    detected = await detectSpecs(issueKey).catch(() => null);
    if (!detected?.pages?.length) suggestions = await suggestSpecs(issue, context.cloudId).catch(() => null);
  }
  return {
    detected,
    suggestions,
    issue: { key: issue.key, summary: issue.summary, isEpic: issue.isEpic, projectKey: issue.projectKey },
    record,
    job,
    stale,
    currentPages,
    dismissed: dismissed || [],
    applied: applied || [],
    created: created || {},
    summary: record?.result ? summarise(record.result, dismissed || []) : null,
  };
});

resolver.define('start', async ({ context }) => {
  const issueKey = issueKeyOf(context);
  await assertCanView(issueKey);
  const job = await kvs.get(jobKey(issueKey));
  if (job && (job.state === 'queued' || job.state === 'running') && Date.now() - job.at < 5 * 60 * 1000) {
    return { ok: true, already: true };
  }
  await queueAnalysis(issueKey);
  return { ok: true };
});

resolver.define('searchSpecs', async ({ payload }) => searchPages(payload?.query || '', 'user'));

resolver.define('linkSpec', async ({ payload, context }) => {
  const issueKey = issueKeyOf(context);
  await assertCanView(issueKey);
  await linkSpecPage(issueKey, payload.page, 'user');
  await queueAnalysis(issueKey);
  return { ok: true };
});

resolver.define('addCriterion', async ({ payload, context }) => {
  const issueKey = issueKeyOf(context);
  const target = payload.targetKey || issueKey;
  await assertCanView(target);
  await appendAcceptanceCriterion(target, payload.text, 'user');
  const applied = (await kvs.get(appliedKey(issueKey))) || [];
  await kvs.set(appliedKey(issueKey), [...new Set([...applied, payload.fid])]);
  return { ok: true, target };
});

resolver.define('createFollowUp', async ({ payload, context }) => {
  const issueKey = issueKeyOf(context);
  const issue = await assertCanView(issueKey);
  const key = await createFollowUp(issue, payload.summary, payload.details, 'user');
  const applied = (await kvs.get(appliedKey(issueKey))) || [];
  await kvs.set(appliedKey(issueKey), [...new Set([...applied, payload.fid])]);
  const created = (await kvs.get(`created:${issueKey}`)) || {};
  created[payload.fid] = key;
  await kvs.set(`created:${issueKey}`, created);
  return { ok: true, key };
});

resolver.define('askQuestion', async ({ payload, context }) => {
  const issueKey = issueKeyOf(context);
  await assertCanView(issueKey);
  const text = `Open question from Driftwise — the spec says: "${payload.specQuote}". ${payload.question} Please confirm before this ships.`;
  await addComment(issueKey, text, 'user');
  const applied = (await kvs.get(appliedKey(issueKey))) || [];
  await kvs.set(appliedKey(issueKey), [...new Set([...applied, payload.fid])]);
  return { ok: true };
});

resolver.define('dismiss', async ({ payload, context }) => {
  const issueKey = issueKeyOf(context);
  await assertCanView(issueKey);
  const cur = (await kvs.get(dismissedKey(issueKey))) || [];
  const next = payload.undo ? cur.filter((f) => f !== payload.fid) : [...new Set([...cur, payload.fid])];
  await kvs.set(dismissedKey(issueKey), next);
  return { ok: true, dismissed: next };
});

async function rowFor(key, summaryHint) {
  const [record, job, dismissed] = await Promise.all([
    kvs.get(analysisKey(key)), kvs.get(jobKey(key)), kvs.get(dismissedKey(key)),
  ]);
  const sum = record?.result ? summarise(record.result, dismissed || []) : null;
  return {
    key,
    summary: summaryHint || record?.summaryText || key,
    state: record?.state || 'none',
    job: job?.state || null,
    confidence: sum?.confidence ?? null,
    counts: sum?.counts || null,
    outOfSpec: sum?.outOfSpec || 0,
    questions: sum?.questions || 0,
    analyzedAt: record?.analyzedAt || null,
    spec: (record?.pages || []).filter((p) => !p.error).map((p) => ({ title: p.title, url: p.url })),
  };
}

resolver.define('projectOverview', async ({ context }) => {
  const projectKey = context?.extension?.project?.key;
  const epics = await searchIssues(`project = "${projectKey}" AND issuetype = Epic ORDER BY updated DESC`, 'user', 30).catch(() => []);
  const indexed = (await kvs.get(`project:${projectKey}`)) || [];
  const visible = new Map(epics.map((e) => [e.key, e.summary]));
  // Indexed items are re-checked with the user's permissions before they are shown.
  const extra = indexed.filter((k) => !visible.has(k));
  if (extra.length) {
    const seen = await searchIssues(`key in (${extra.join(',')})`, 'user', 50).catch(() => []);
    for (const i of seen) visible.set(i.key, i.summary);
  }
  const rows = await Promise.all([...visible.entries()].map(([k, s]) => rowFor(k, s)));
  rows.sort((a, b) => (a.confidence ?? 101) - (b.confidence ?? 101));
  const checked = rows.filter((r) => r.confidence !== null);
  const totals = { contradicted: 0, missing: 0, partial: 0, covered: 0 };
  for (const r of checked) for (const k of Object.keys(totals)) totals[k] += r.counts[k] || 0;
  const reqs = Object.values(totals).reduce((a, b) => a + b, 0);
  const overall = reqs ? Math.round((100 * (totals.covered + 0.5 * totals.partial)) / reqs) : null;
  const spend = await getSpend();
  return { projectKey, rows, totals, overall, spend: { usd: spend.usd, budget: MONTHLY_BUDGET_USD } };
});

resolver.define('startFor', async ({ payload }) => {
  await assertCanView(payload.issueKey);
  await queueAnalysis(payload.issueKey);
  return { ok: true };
});

resolver.define('pageCoverage', async ({ context }) => {
  const pageId = String(context?.extension?.content?.id || '');
  if (!pageId) return { items: [] };
  await getPage(pageId, 'user');
  const map = (await kvs.get(`page:${pageId}`)) || {};
  const keys = Object.keys(map);
  let visible = [];
  if (keys.length) visible = await searchIssues(`key in (${keys.join(',')})`, 'user', 50).catch(() => []);
  const items = await Promise.all(visible.map((i) => rowFor(i.key, i.summary)));
  items.sort((a, b) => (a.confidence ?? 101) - (b.confidence ?? 101));
  return { items };
});

export const resolverHandler = resolver.getDefinitions();

export const workerHandler = async (event) => {
  const { issueKey } = event.body || event.payload || {};
  if (!issueKey) return;
  await kvs.set(jobKey(issueKey), { state: 'running', at: Date.now() });
  try {
    await runAnalysis(issueKey);
    await kvs.set(jobKey(issueKey), { state: 'done', at: Date.now() });
  } catch (e) {
    console.error('Analysis failed', issueKey, e);
    await kvs.set(jobKey(issueKey), {
      state: 'error',
      at: Date.now(),
      message: e.code === 'BUDGET' ? e.message : 'The analysis could not finish. Try again in a minute.',
    });
  }
};

export const seedHandler = async (request) => {
  const confirm = request?.queryParameters?.confirm?.[0];
  if (confirm !== 'yes') {
    return { statusCode: 400, headers: { 'Content-Type': ['application/json'] }, body: '{"error":"add ?confirm=yes"}' };
  }
  try {
    const out = await seedDemo(request?.queryParameters?.mode?.[0]);
    return { statusCode: 200, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};

export { getDrift as rovoGetDrift, getSpecAndWork as rovoGetSpecAndWork, addCriterion as rovoAddCriterion, createWork as rovoCreateWork } from './rovo';
