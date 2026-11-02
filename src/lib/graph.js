import api from '@forge/api';
import { getPage, searchPages } from './atlassian';

// Teamwork Graph: find pages in the Confluence spaces that are linked to this
// Jira space, so Driftwise can suggest the spec when nobody linked one.
// Persisted query registered for this app (Teamwork Graph only runs registered Cypher):
// MATCH (js:JiraSpace {ari: $id})<-[:confluence_space_links_jira_space]-(cs:ConfluenceSpace)
//       -[:confluence_space_has_confluence_page]->(p:ConfluencePage) RETURN p LIMIT 150
const QUERY_KEY = '15c614f0-f96b-453f-bb46-1db7e9ab1e5e';
const QUERY = `query driftwise_specCandidates($queryKey: String!, $queryParams: CypherRequestParams, $after: String) {
  customQuery(queryKey: $queryKey, queryParams: $queryParams, first: 25, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node { columns { key value {
      __typename
      ... on CypherQueryResultNode { id }
      ... on CypherQueryResultListNode { nodes { id } }
    } } } }
  }
}`;


const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'v1', 'v2', 'v3', 'new', 'page']);
const words = (s = '') => s.toLowerCase().split(/[^a-z0-9À-￿]+/).filter((w) => w.length > 1 && !STOP.has(w));

function similarity(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

const SPEC_HINT = /(requirement|prd|spec|specification|brief|design doc|rfc|proposal|需求|規格)/i;

async function graphPageIds(cloudId, projectId) {
  const projectAri = `ari:cloud:jira:${cloudId}:project/${projectId}`;
  const run = async (queryParams, after) => {
    const res = await api.asUser().requestTeamworkGraph(QUERY, { queryKey: QUERY_KEY, queryParams, after }, 'driftwise_specCandidates');
    return res.json();
  };
  let params = { id: projectAri };
  let json = await run(params);
  if (json.errors?.length) {
    console.warn('Teamwork Graph first attempt', json.errors[0].message);
    params = { params: { id: projectAri } };
    json = await run(params);
  }
  if (json.errors?.length) throw new Error(json.errors[0].message);
  const edges = [...(json.data?.customQuery?.edges || [])];
  let info = json.data?.customQuery?.pageInfo;
  for (let i = 0; i < 3 && info?.hasNextPage; i += 1) {
    const next = await run(params, info.endCursor);
    edges.push(...(next.data?.customQuery?.edges || []));
    info = next.data?.customQuery?.pageInfo;
  }
  const ids = new Set();
  for (const edge of edges) {
    for (const col of edge.node?.columns || []) {
      const vals = col.value?.nodes || (col.value?.id ? [col.value] : []);
      for (const v of vals) {
        const m = String(v.id || '').match(/page\/(\d+)/);
        if (m) ids.add(m[1]);
      }
    }
  }
  return [...ids];
}

export async function suggestSpecs(issue, cloudId) {
  const out = { source: null, pages: [], note: null };
  try {
    const ids = await graphPageIds(cloudId, issue.projectId);
    if (ids.length) {
      const pages = [];
      for (const id of ids.slice(0, 60)) {
        // Titles are read as the user, so suggestions respect page restrictions.
        const p = await getPage(id, 'user').catch(() => null);
        if (p) pages.push({ id: p.id, title: p.title, url: p.url });
      }
      out.pages = pages
        .map((p) => ({ ...p, score: similarity(issue.summary, p.title) + (SPEC_HINT.test(p.title) ? 0.25 : 0) }))
        .filter((p) => p.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      out.source = 'teamwork-graph';
    }
  } catch (e) {
    out.note = `Teamwork Graph unavailable: ${String(e.message || e).slice(0, 120)}`;
    console.warn('Teamwork Graph lookup failed', String(e.message || e));
  }
  console.log('Teamwork Graph candidates', out.source, out.pages.length);
  if (!out.pages.length) {
    const seen = new Map();
    for (const w of words(issue.summary).slice(0, 3)) {
      for (const p of await searchPages(w, 'user').catch(() => [])) seen.set(p.id, p);
    }
    const found = [...seen.values()];
    if (found.length) {
      out.pages = found
        .map((p) => ({ ...p, score: similarity(issue.summary, p.title) + (SPEC_HINT.test(p.title) ? 0.25 : 0) }))
        .filter((p) => p.score > 0.2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      if (out.pages.length) out.source = out.source || 'search';
    }
  }
  return out;
}
