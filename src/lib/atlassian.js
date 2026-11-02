import api, { route } from '@forge/api';
import { adfToText, extractPageIds, storageToText } from './text';

const client = (as) => (as === 'user' ? api.asUser() : api.asApp());

async function call(fn, label) {
  const res = await fn();
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${label} failed: ${res.status} ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

const jira = (as, r, opts) => call(() => client(as).requestJira(r, opts), `Jira ${r}`);
const conf = (as, r, opts) => call(() => client(as).requestConfluence(r, opts), `Confluence ${r}`);
const json = (method, body) => ({
  method,
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------- Jira ----------

const ISSUE_FIELDS = 'summary,description,issuetype,status,parent,subtasks,comment,labels,fixVersions,updated,project,priority';

export async function getIssue(key, as = 'app') {
  const issue = await jira(as, route`/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`);
  const f = issue.fields;
  const comments = (f.comment?.comments || []).slice(-8).map((c) => ({
    author: c.author?.displayName || 'Someone',
    created: c.created,
    text: adfToText(c.body).trim(),
  }));
  return {
    key: issue.key,
    id: issue.id,
    summary: f.summary,
    description: adfToText(f.description).trim(),
    descriptionAdf: f.description,
    type: f.issuetype?.name,
    isEpic: f.issuetype?.hierarchyLevel === 1 || (f.issuetype?.name || '').toLowerCase() === 'epic',
    status: f.status?.name,
    statusCategory: f.status?.statusCategory?.key,
    parentKey: f.parent?.key,
    projectKey: f.project?.key,
    projectId: f.project?.id,
    labels: f.labels || [],
    fixVersions: (f.fixVersions || []).map((v) => v.name),
    updated: f.updated,
    comments,
  };
}

export async function searchIssues(jql, as = 'app', max = 50) {
  const res = await jira(as, route`/rest/api/3/search/jql`, json('POST', {
    jql,
    maxResults: max,
    fields: ['summary', 'description', 'issuetype', 'status', 'updated', 'fixVersions'],
  }));
  return (res.issues || []).map((i) => ({
    key: i.key,
    summary: i.fields.summary,
    description: adfToText(i.fields.description).trim(),
    type: i.fields.issuetype?.name,
    status: i.fields.status?.name,
    statusCategory: i.fields.status?.statusCategory?.key,
    updated: i.fields.updated,
  }));
}

export async function getChildren(key, as = 'app') {
  return searchIssues(`parent = ${key} ORDER BY rank`, as, 60);
}

export async function getRemoteLinks(key, as = 'app') {
  return (await jira(as, route`/rest/api/3/issue/${key}/remotelink`)) || [];
}

export async function findSpecPageIds(issue, as = 'app') {
  const ids = new Set(extractPageIds(issue.description));
  const links = await getRemoteLinks(issue.key, as).catch(() => []);
  for (const l of links) {
    const url = l.object?.url || '';
    for (const id of extractPageIds(url)) ids.add(id);
    const m = (l.globalId || '').match(/pageId=(\d+)|driftwise-page-(\d+)/);
    if (m) ids.add(m[1] || m[2]);
  }
  return [...ids];
}

export async function linkSpecPage(issueKey, page, as = 'user') {
  return jira(as, route`/rest/api/3/issue/${issueKey}/remotelink`, json('POST', {
    globalId: `driftwise-page-${page.id}`,
    application: { type: 'com.atlassian.confluence', name: 'Confluence' },
    relationship: 'Specified by',
    object: {
      url: page.url,
      title: page.title,
      icon: { url16x16: 'https://wac-cdn.atlassian.com/assets/img/favicons/confluence/favicon.png', title: 'Confluence' },
    },
  }));
}

const AC_HEADING = 'Acceptance criteria';

export async function appendAcceptanceCriterion(issueKey, criterion, as = 'user') {
  const issue = await jira(as, route`/rest/api/3/issue/${issueKey}?fields=description`);
  const doc = issue.fields.description || { type: 'doc', version: 1, content: [] };
  const content = [...(doc.content || [])];
  const item = {
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: criterion }] }],
  };
  const headingIdx = content.findIndex(
    (n) => n.type === 'heading' && adfToText(n).toLowerCase().includes(AC_HEADING.toLowerCase()),
  );
  if (headingIdx >= 0) {
    let i = headingIdx + 1;
    while (i < content.length && content[i].type !== 'heading' && content[i].type !== 'bulletList') i += 1;
    if (i < content.length && content[i].type === 'bulletList') {
      content[i] = { ...content[i], content: [...content[i].content, item] };
    } else {
      content.splice(headingIdx + 1, 0, { type: 'bulletList', content: [item] });
    }
  } else {
    content.push(
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: AC_HEADING }] },
      { type: 'bulletList', content: [item] },
    );
  }
  await jira(as, route`/rest/api/3/issue/${issueKey}`, json('PUT', {
    fields: { description: { ...doc, content } },
  }));
  return true;
}

export async function createFollowUp(fromIssue, summary, details, as = 'user') {
  const meta = await jira(as, route`/rest/api/3/issue/createmeta/${fromIssue.projectKey}/issuetypes`);
  const types = meta.issueTypes || meta.values || [];
  // Pick by hierarchy level, not name: names are localised (e.g. 故事 / 大型工作).
  const level0 = types.filter((t) => !t.subtask && (t.hierarchyLevel === 0 || t.hierarchyLevel === undefined));
  const pick = level0.find((t) => /story|故事|история|histoire|historia/i.test(t.name))
    || level0.find((t) => !/bug|錯誤|epic|大型/i.test(t.name))
    || level0[0] || types.find((t) => !t.subtask);
  const fields = {
    project: { key: fromIssue.projectKey },
    issuetype: { id: pick.id },
    summary: summary.slice(0, 250),
    description: {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: details }] },
        { type: 'paragraph', content: [{ type: 'text', text: `Raised by Driftwise from ${fromIssue.key}.` }] },
      ],
    },
  };
  if (fromIssue.isEpic) fields.parent = { key: fromIssue.key };
  else if (fromIssue.parentKey) fields.parent = { key: fromIssue.parentKey };
  let created;
  try {
    created = await jira(as, route`/rest/api/3/issue`, json('POST', { fields }));
  } catch (e) {
    delete fields.parent;
    created = await jira(as, route`/rest/api/3/issue`, json('POST', { fields }));
  }
  if (!fromIssue.isEpic) {
    await jira(as, route`/rest/api/3/issueLink`, json('POST', {
      type: { name: 'Relates' },
      inwardIssue: { key: created.key },
      outwardIssue: { key: fromIssue.key },
    })).catch(() => null);
  }
  return created.key;
}

export async function addComment(issueKey, text, as = 'user') {
  return jira(as, route`/rest/api/3/issue/${issueKey}/comment`, json('POST', {
    body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  }));
}

// ---------- Confluence ----------

export async function getPage(id, as = 'app') {
  const p = await conf(as, route`/wiki/api/v2/pages/${id}?body-format=storage`);
  const base = p._links?.base || '';
  return {
    id: String(p.id),
    title: p.title,
    spaceId: p.spaceId,
    version: p.version?.number,
    updatedAt: p.version?.createdAt,
    url: `${base}${p._links?.webui || ''}`,
    text: storageToText(p.body?.storage?.value || ''),
  };
}

export async function searchPages(query, as = 'user') {
  const q = String(query || '').replace(/["\\]/g, ' ').trim();
  const cql = q ? `type = page AND title ~ "${q}*"` : 'type = page ORDER BY lastmodified DESC';
  const res = await conf(as, route`/wiki/rest/api/search?cql=${cql}&limit=8`);
  const base = res._links?.base || '';
  return (res.results || [])
    .filter((r) => r.content?.id)
    .map((r) => ({
      id: String(r.content.id),
      title: r.content.title || r.title,
      url: `${base}${r.content._links?.webui || r.url || ''}`,
      space: r.resultGlobalContainer?.title || '',
      lastModified: r.friendlyLastModified || '',
    }));
}

export async function listSpaces(as = 'app') {
  const res = await conf(as, route`/wiki/api/v2/spaces?limit=25`);
  return res.results || [];
}

export async function createSpace(key, name, as = 'app') {
  return conf(as, route`/wiki/api/v2/spaces`, json('POST', { key, name }));
}

export async function createPage(spaceId, title, storage, as = 'app') {
  const p = await conf(as, route`/wiki/api/v2/pages`, json('POST', {
    spaceId,
    status: 'current',
    title,
    body: { representation: 'storage', value: storage },
  }));
  return { id: String(p.id), title: p.title, url: `${p._links?.base || ''}${p._links?.webui || ''}` };
}

export async function findPageByTitle(spaceId, title, as = 'app') {
  const res = await conf(as, route`/wiki/api/v2/spaces/${spaceId}/pages?title=${title}&limit=5`);
  const p = (res.results || [])[0];
  if (!p) return null;
  return { id: String(p.id), title: p.title, url: `${res._links?.base || ''}${p._links?.webui || ''}` };
}

export async function createIssueRaw(fields, as = 'app') {
  return jira(as, route`/rest/api/3/issue`, json('POST', { fields }));
}

export async function getIssueTypes(projectKey, as = 'app') {
  const meta = await jira(as, route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`);
  return meta.issueTypes || meta.values || [];
}
