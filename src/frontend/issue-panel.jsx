import React, { useCallback, useEffect, useRef, useState } from 'react';
import ForgeReconciler, {
  Box, Button, EmptyState, Heading, Inline, Link, LoadingButton, Lozenge, ProgressBar, SectionMessage,
  Spinner, Stack, Tab, TabList, TabPanel, Tabs, Text, Textfield, Tooltip, xcss,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const STATUS = {
  contradicted: { label: 'Contradicts spec', appearance: 'removed', rank: 0 },
  missing: { label: 'Not planned', appearance: 'moved', rank: 1 },
  partial: { label: 'Partly covered', appearance: 'inprogress', rank: 2 },
  covered: { label: 'Covered', appearance: 'success', rank: 3 },
};

const card = xcss({
  padding: 'space.150',
  borderColor: 'color.border',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderRadius: 'border.radius.200',
  backgroundColor: 'elevation.surface',
});
const quoteBox = xcss({
  paddingInline: 'space.100',
  paddingBlock: 'space.050',
  borderLeftWidth: 'border.width.selected',
  borderLeftStyle: 'solid',
  borderLeftColor: 'color.border.bold',
  backgroundColor: 'color.background.neutral.subtle.hovered',
});
const specBorder = xcss({ borderLeftColor: 'color.border.discovery' });
const workBorder = xcss({ borderLeftColor: 'color.border.information' });

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function modelName(m = '') {
  return m.replace(/^claude-/, 'Claude ').replace(/-\d{8}$/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1')
    .replace('sonnet', 'Sonnet').replace('opus', 'Opus').replace('haiku', 'Haiku');
}

function Quote({ label, text, verified, kind }) {
  if (!text) return null;
  return (
    <Box xcss={[quoteBox, kind === 'spec' ? specBorder : workBorder]}>
      <Stack space="space.050">
        <Inline space="space.100" alignBlock="center">
          <Text size="small" weight="semibold" color="color.text.subtle">{label}</Text>
          {verified === true && (
            <Tooltip content="Driftwise found this exact wording in the source.">
              <Lozenge appearance="success">verified quote</Lozenge>
            </Tooltip>
          )}
          {verified === false && (
            <Tooltip content="This wording could not be matched to the source. Check it before acting.">
              <Lozenge appearance="moved">check wording</Lozenge>
            </Tooltip>
          )}
        </Inline>
        <Text>“{text}”</Text>
      </Stack>
    </Box>
  );
}

function Finding({ r, issueKey, applied, created = {}, onAction, busy }) {
  const s = STATUS[r.status];
  const done = applied.includes(r.fid);
  const target = r.issueKey || issueKey;
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Inline spread="space-between" alignBlock="center" shouldWrap>
          <Inline space="space.100" alignBlock="center" shouldWrap>
            <Lozenge appearance={s.appearance} isBold>{s.label}</Lozenge>
            <Text weight="semibold">{r.requirement}</Text>
          </Inline>
          {r.issueKey && r.issueKey !== issueKey && <Lozenge>{r.issueKey}</Lozenge>}
        </Inline>
        <Quote label="Spec says" text={r.specQuote} verified={r.specVerified} kind="spec" />
        <Quote label={r.issueKey ? `${r.issueKey} says` : 'Jira says'} text={r.evidenceQuote} verified={r.evidenceVerified} kind="work" />
        {r.explanation && <Text color="color.text.subtle">{r.explanation}</Text>}
        {r.status !== 'covered' && r.suggestedCriterion && (
          <Text size="small"><Text weight="semibold" size="small">Suggested acceptance criterion: </Text>{r.suggestedCriterion}</Text>
        )}
        {r.status !== 'covered' && (
          <Inline space="space.100" shouldWrap>
            {done ? (
              <Lozenge appearance="success">
                {created[r.fid] ? `Created ${created[r.fid]}` : `Criterion added to ${target}`}
              </Lozenge>
            ) : (
              <>
                {r.suggestedCriterion && r.status !== 'missing' && (
                  <LoadingButton
                    appearance="primary"
                    spacing="compact"
                    isLoading={busy === `${r.fid}:ac`}
                    onClick={() => onAction('addCriterion', { fid: r.fid, text: r.suggestedCriterion, targetKey: target }, `${r.fid}:ac`)}
                  >
                    Add criterion to {target}
                  </LoadingButton>
                )}
                {r.status === 'missing' && (
                  <LoadingButton
                    appearance="primary"
                    spacing="compact"
                    isLoading={busy === `${r.fid}:fu`}
                    onClick={() => onAction('createFollowUp', {
                      fid: r.fid,
                      summary: r.requirement,
                      details: `Spec requirement not covered by any planned work: "${r.specQuote}". ${r.suggestedCriterion ? `Acceptance criterion: ${r.suggestedCriterion}` : ''}`,
                    }, `${r.fid}:fu`)}
                  >
                    Create work item
                  </LoadingButton>
                )}
                <Button spacing="compact" appearance="subtle" onClick={() => onAction('dismiss', { fid: r.fid }, `${r.fid}:d`)}>
                  Not an issue
                </Button>
              </>
            )}
          </Inline>
        )}
      </Stack>
    </Box>
  );
}

function OutOfSpec({ o, onAction }) {
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Lozenge appearance="discovery" isBold>Not in spec</Lozenge>
          {o.issueKey && <Lozenge>{o.issueKey}</Lozenge>}
        </Inline>
        <Quote label={o.issueKey ? `${o.issueKey} says` : 'Jira says'} text={o.evidenceQuote} verified={o.evidenceVerified} kind="work" />
        <Text color="color.text.subtle">{o.explanation}</Text>
        <Inline>
          <Button spacing="compact" appearance="subtle" onClick={() => onAction('dismiss', { fid: o.fid }, `${o.fid}:d`)}>
            Intended — dismiss
          </Button>
        </Inline>
      </Stack>
    </Box>
  );
}

function Question({ q, applied, onAction, busy }) {
  const done = applied.includes(q.fid);
  return (
    <Box xcss={card}>
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center">
          <Lozenge appearance="new" isBold>Open question</Lozenge>
        </Inline>
        <Quote label="Spec says" text={q.specQuote} verified={q.specVerified} kind="spec" />
        <Text>{q.question}</Text>
        <Inline space="space.100">
          {done ? (
            <Lozenge appearance="success">Asked in comments</Lozenge>
          ) : (
            <LoadingButton
              spacing="compact"
              isLoading={busy === `${q.fid}:q`}
              onClick={() => onAction('askQuestion', { fid: q.fid, question: q.question, specQuote: q.specQuote }, `${q.fid}:q`)}
            >
              Ask in comments
            </LoadingButton>
          )}
          <Button spacing="compact" appearance="subtle" onClick={() => onAction('dismiss', { fid: q.fid }, `${q.fid}:d`)}>
            Dismiss
          </Button>
        </Inline>
      </Stack>
    </Box>
  );
}

function LinkSpec({ onLinked, suggestions }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(null);
  const search = async (q) => {
    setResults(null);
    setResults(await invoke('searchSpecs', { query: q }));
  };
  useEffect(() => { search(''); }, []);
  return (
    <Stack space="space.150">
      <EmptyState
        header="Link the spec this work should follow"
        description="Driftwise compares this work with its Confluence spec and tells you what is missing, partly covered or contradicted — before you ship."
      />
      {suggestions?.pages?.length > 0 && (
        <Box xcss={card}>
          <Stack space="space.100">
            <Inline space="space.100" alignBlock="center">
              <Text weight="semibold">Likely spec</Text>
              <Lozenge appearance="discovery">
                {suggestions.source === 'teamwork-graph' ? 'found via Teamwork Graph' : 'found via search'}
              </Lozenge>
            </Inline>
            {suggestions.source === 'teamwork-graph' && (
              <Text size="small" color="color.text.subtle">From the Confluence spaces linked to this Jira space.</Text>
            )}
            {suggestions.pages.map((p) => (
              <Inline key={p.id} spread="space-between" alignBlock="center">
                <Link href={p.url} openNewTab>{p.title}</Link>
                <LoadingButton
                  appearance="primary"
                  spacing="compact"
                  isLoading={busy === p.id}
                  onClick={async () => { setBusy(p.id); await invoke('linkSpec', { page: p }); onLinked(); }}
                >
                  Use as spec
                </LoadingButton>
              </Inline>
            ))}
          </Stack>
        </Box>
      )}
      <Textfield
        placeholder="Search Confluence pages by title"
        value={query}
        onChange={(e) => { setQuery(e.target.value); search(e.target.value); }}
      />
      {!results && <Spinner size="medium" />}
      {results && !results.length && <Text color="color.text.subtle">No pages found.</Text>}
      {results && results.map((p) => (
        <Inline key={p.id} spread="space-between" alignBlock="center">
          <Stack space="space.0">
            <Text weight="semibold">{p.title}</Text>
            <Text size="small" color="color.text.subtle">{[p.space, p.lastModified].filter(Boolean).join(' · ')}</Text>
          </Stack>
          <LoadingButton
            spacing="compact"
            isLoading={busy === p.id}
            onClick={async () => { setBusy(p.id); await invoke('linkSpec', { page: p }); onLinked(); }}
          >
            Use as spec
          </LoadingButton>
        </Inline>
      ))}
    </Stack>
  );
}

function StartScreen({ detected, issue, onStart, job }) {
  const items = detected.childCount;
  return (
    <Stack space="space.150">
      {job?.state === 'error' && <SectionMessage appearance="error">{job.message}</SectionMessage>}
      <Heading size="small">Check this work against its spec</Heading>
      <Inline space="space.050" shouldWrap alignBlock="center">
        <Text>Spec found:</Text>
        {detected.pages.map((p) => <Link key={p.id} href={p.url} openNewTab>{p.title}</Link>)}
        {detected.inheritedFrom && <Text color="color.text.subtle">(from {detected.inheritedFrom})</Text>}
      </Inline>
      <Text color="color.text.subtle">
        Driftwise reads the spec and {items ? `${issue.key} with its ${items} child work items` : issue.key}, then shows every requirement that is missing, partly covered or contradicted — each backed by quotes you can verify.
      </Text>
      <Inline>
        <Button appearance="primary" onClick={onStart}>Check against spec</Button>
      </Inline>
    </Stack>
  );
}

function Working({ job, record }) {
  return (
    <Stack space="space.150">
      <Inline space="space.100" alignBlock="center">
        <Spinner size="small" />
        <Text weight="semibold">{job.state === 'queued' ? 'Queued…' : 'Reading the spec and the planned work…'}</Text>
      </Inline>
      <ProgressBar isIndeterminate ariaLabel="Analysis in progress" />
      <Text size="small" color="color.text.subtle">
        Driftwise checks every requirement against the work item{record?.childCount ? ` and its ${record.childCount} child items` : ''}. This usually takes 20–60 seconds.
      </Text>
    </Stack>
  );
}

function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const s = await invoke('getState');
      setState(s);
      setError(null);
      return s;
    } catch (e) {
      setError(String(e.message || e));
      return null;
    }
  }, []);

  const active = state?.job && (state.job.state === 'queued' || state.job.state === 'running');

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    clearTimeout(timer.current);
    if (active) timer.current = setTimeout(load, 3000);
    return () => clearTimeout(timer.current);
  }, [state, active, load]);

  const start = async () => {
    setState((s) => ({ ...s, job: { state: 'queued', at: Date.now() } }));
    await invoke('start');
    load();
  };

  const onAction = async (name, payload, busyKey) => {
    setBusy(busyKey);
    try {
      await invoke(name, payload);
      await load();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(null);
    }
  };

  if (error && !state) return <SectionMessage appearance="error" title="Driftwise could not load">{error}</SectionMessage>;
  if (!state) return <Spinner size="medium" />;

  const { record, job, summary, dismissed, applied, stale, issue } = state;

  if (active) return <Working job={job} record={record} />;
  if (!record || record.state === 'no-spec') {
    if (state.detected?.pages?.length) return <StartScreen detected={state.detected} issue={issue} onStart={start} job={job} />;
    return (
      <Stack space="space.150">
        {job?.state === 'error' && <SectionMessage appearance="error">{job.message}</SectionMessage>}
        <LinkSpec onLinked={load} suggestions={state.suggestions} />
      </Stack>
    );
  }

  if (record.state === 'spec-unreadable') {
    return (
      <SectionMessage appearance="warning" title="The linked spec can't be read">
        <Text>Driftwise found a spec link but could not open the page. It may be restricted or deleted.</Text>
      </SectionMessage>
    );
  }

  const res = record.result;
  const reqs = res.requirements.filter((r) => !dismissed.includes(r.fid));
  const drift = reqs.filter((r) => r.status !== 'covered').sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank);
  const covered = reqs.filter((r) => r.status === 'covered');
  const oos = res.outOfSpec.filter((o) => !dismissed.includes(o.fid));
  const qs = res.questions.filter((q) => !dismissed.includes(q.fid));
  const conf = summary.confidence ?? 0;
  const verdict = conf >= 85 ? { t: 'Ready to ship', a: 'success' } : conf >= 60 ? { t: 'Some drift', a: 'inprogress' } : { t: 'Significant drift', a: 'removed' };
  const pages = state.currentPages || record.pages;

  return (
    <Stack space="space.200">
      {job?.state === 'error' && <SectionMessage appearance="error">{job.message}</SectionMessage>}
      {error && <SectionMessage appearance="error">{error}</SectionMessage>}
      {stale && (
        <SectionMessage
          appearance="information"
          title="The spec or the work changed since the last check"
          actions={[<Button key="r" appearance="link" onClick={start}>Re-check now</Button>]}
        />
      )}

      <Stack space="space.100">
        <Inline spread="space-between" alignBlock="center">
          <Heading size="large">{conf}% spec confidence</Heading>
          <Lozenge appearance={verdict.a} isBold>{verdict.t}</Lozenge>
        </Inline>
        <ProgressBar value={conf / 100} appearance={conf >= 85 ? 'success' : 'default'} ariaLabel="Spec confidence" />
        <Text>{res.summary}</Text>
        <Inline space="space.100" shouldWrap>
          {summary.counts.contradicted > 0 && <Lozenge appearance="removed">{summary.counts.contradicted} contradicted</Lozenge>}
          {summary.counts.missing > 0 && <Lozenge appearance="moved">{summary.counts.missing} not planned</Lozenge>}
          {summary.counts.partial > 0 && <Lozenge appearance="inprogress">{summary.counts.partial} partly covered</Lozenge>}
          <Lozenge appearance="success">{summary.counts.covered} covered</Lozenge>
          {oos.length > 0 && <Lozenge appearance="discovery">{oos.length} not in spec</Lozenge>}
        </Inline>
        <Inline space="space.050" shouldWrap alignBlock="center">
          <Text size="small" color="color.text.subtle">Checked against</Text>
          {pages.filter((p) => !p.error).map((p) => (
            <Link key={p.id} href={p.url} openNewTab>{p.title}{p.version ? ` (v${p.version})` : ''}</Link>
          ))}
          {record.inheritedFrom && <Text size="small" color="color.text.subtle">· spec inherited from {record.inheritedFrom}</Text>}
        </Inline>
      </Stack>

      <Tabs id="driftwise-tabs">
        <TabList>
          <Tab>Drift ({drift.length})</Tab>
          <Tab>Covered ({covered.length})</Tab>
          <Tab>Not in spec ({oos.length})</Tab>
          <Tab>Questions ({qs.length})</Tab>
        </TabList>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: 'space.150', width: '100%' })}>
            <Stack space="space.100">
              {drift.length === 0 && <Text>No drift found. Every in-scope requirement is covered.</Text>}
              {drift.map((r) => <Finding key={r.fid} r={r} issueKey={issue.key} applied={applied} created={state.created} onAction={onAction} busy={busy} />)}
            </Stack>
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: 'space.150', width: '100%' })}>
            <Stack space="space.100">
              {covered.length === 0 && <Text>Nothing fully covered yet.</Text>}
              {covered.map((r) => <Finding key={r.fid} r={r} issueKey={issue.key} applied={applied} created={state.created} onAction={onAction} busy={busy} />)}
            </Stack>
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: 'space.150', width: '100%' })}>
            <Stack space="space.100">
              {oos.length === 0 && <Text>No work outside the spec.</Text>}
              {oos.map((o) => <OutOfSpec key={o.fid} o={o} onAction={onAction} />)}
            </Stack>
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingTop: 'space.150', width: '100%' })}>
            <Stack space="space.100">
              {qs.length === 0 && <Text>No open questions.</Text>}
              {qs.map((q) => <Question key={q.fid} q={q} applied={applied} onAction={onAction} busy={busy} />)}
            </Stack>
          </Box>
        </TabPanel>
      </Tabs>

      <Inline spread="space-between" alignBlock="center" shouldWrap>
        <Text size="small" color="color.text.subtle">
          Checked {ago(record.analyzedAt)} · {modelName(record.model)} via Forge LLMs · every quote matched against its source
          {dismissed.length ? ` · ${dismissed.length} dismissed` : ''}
        </Text>
        <Button spacing="compact" onClick={start}>Re-check</Button>
      </Inline>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
