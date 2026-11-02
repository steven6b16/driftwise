import { kvs } from '@forge/kvs';
import { Queue } from '@forge/events';
import { appendAcceptanceCriterion, createFollowUp, getIssue } from './lib/atlassian';
import { analysisKey, dismissedKey, gatherContext, summarise } from './lib/analysis';
import { truncate } from './lib/text';

const queue = new Queue({ key: 'driftwise-analysis' });

function keyFrom(payload) {
  const raw = payload?.issueKey || payload?.context?.jira?.issueKey || payload?.context?.jira?.issueKeys?.[0] || '';
  const m = String(raw).toUpperCase().match(/[A-Z][A-Z0-9_]+-\d+/);
  return m ? m[0] : null;
}

const fail = (message) => ({ ok: false, message });

export async function getDrift(payload) {
  const issueKey = keyFrom(payload);
  if (!issueKey) return fail('Ask the user which Jira work item (for example SCRUM-1) to check.');
  await getIssue(issueKey, 'user');
  const [record, job, dismissed] = await Promise.all([
    kvs.get(analysisKey(issueKey)), kvs.get(`job:${issueKey}`), kvs.get(dismissedKey(issueKey)),
  ]);
  if (job && (job.state === 'queued' || job.state === 'running')) {
    return { ok: true, status: 'checking', message: `Driftwise is checking ${issueKey} against its spec right now. Tell the user to ask again in about a minute.` };
  }
  let stale = false;
  if (record?.state === 'done') {
    const ctx = await gatherContext(issueKey).catch(() => null);
    stale = !!ctx && ctx.fingerprint !== record.fingerprint;
  }
  if (!record || record.state !== 'done' || stale) {
    if (record?.state === 'no-spec' && !stale) {
      return { ok: true, status: 'no-spec', message: `${issueKey} has no Confluence spec linked. The user can link one from the Driftwise panel on the work item, or you can use get-spec-and-work after they share the page.` };
    }
    await kvs.set(`job:${issueKey}`, { state: 'queued', at: Date.now() });
    await queue.push([{ body: { issueKey } }]);
    return { ok: true, status: 'checking', message: `${stale ? 'The spec or work changed since the last check, so ' : ''}Driftwise started checking ${issueKey}. Ask again in about a minute.` };
  }
  const d = dismissed || [];
  const sum = summarise(record.result, d);
  const open = record.result.requirements
    .filter((r) => r.status !== 'covered' && !d.includes(r.fid))
    .map((r) => ({
      status: r.status, requirement: r.requirement, workItem: r.issueKey, specSays: r.specQuote, jiraSays: r.evidenceQuote,
      quotesVerified: r.specVerified && (r.evidenceVerified !== false), why: r.explanation, suggestedAcceptanceCriterion: r.suggestedCriterion,
    }));
  return {
    ok: true,
    status: 'done',
    issueKey,
    specConfidencePercent: sum.confidence,
    counts: sum.counts,
    verdict: record.result.summary,
    checkedAt: record.analyzedAt,
    specPages: record.pages.filter((p) => !p.error).map((p) => ({ title: p.title, url: p.url, version: p.version })),
    drift: open,
    notInSpec: record.result.outOfSpec.filter((o) => !d.includes(o.fid)).map((o) => ({ workItem: o.issueKey, jiraSays: o.evidenceQuote, why: o.explanation })),
    openQuestions: record.result.questions.filter((q) => !d.includes(q.fid)).map((q) => ({ specSays: q.specQuote, question: q.question })),
  };
}

export async function getSpecAndWork(payload) {
  const issueKey = keyFrom(payload);
  if (!issueKey) return fail('Ask the user which Jira work item to read.');
  await getIssue(issueKey, 'user');
  const ctx = await gatherContext(issueKey);
  if (!ctx.readable.length) return fail(`${issueKey} has no readable Confluence spec linked.`);
  return {
    ok: true,
    issueKey,
    spec: ctx.readable.map((p) => ({ title: p.title, url: p.url, version: p.version, text: truncate(p.text, 12000) })),
    workItem: { key: ctx.issue.key, summary: ctx.issue.summary, status: ctx.issue.status, description: truncate(ctx.issue.description, 3000) },
    children: ctx.children.map((c) => ({ key: c.key, summary: c.summary, status: c.status, description: truncate(c.description, 1200) })),
  };
}

export async function addCriterion(payload) {
  const issueKey = keyFrom(payload);
  const criterion = String(payload?.criterion || '').trim();
  if (!issueKey || !criterion) return fail('Both the work item key and the acceptance criterion text are needed.');
  await appendAcceptanceCriterion(issueKey, criterion, 'user');
  return { ok: true, message: `Added the acceptance criterion to ${issueKey}.` };
}

export async function createWork(payload) {
  const issueKey = keyFrom(payload);
  const summary = String(payload?.summary || '').trim();
  if (!issueKey || !summary) return fail('The related work item key and a summary are needed.');
  const issue = await getIssue(issueKey, 'user');
  const key = await createFollowUp(issue, summary, String(payload?.details || summary), 'user');
  return { ok: true, created: key, message: `Created ${key}.` };
}
