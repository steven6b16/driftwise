import React, { useCallback, useEffect, useRef, useState } from 'react';
import ForgeReconciler, {
  Box, Button, DynamicTable, Heading, Inline, Link, LoadingButton, Lozenge, ProgressBar, SectionMessage,
  Spinner, Stack, Text, xcss,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';

const tile = xcss({
  padding: 'space.200',
  borderColor: 'color.border',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderRadius: 'border.radius.200',
  minWidth: '150px',
  backgroundColor: 'elevation.surface',
});

function Tile({ label, value, appearance }) {
  return (
    <Box xcss={tile}>
      <Stack space="space.050">
        <Text size="small" color="color.text.subtle">{label}</Text>
        <Inline alignBlock="center" space="space.100">
          <Heading size="large">{value}</Heading>
          {appearance && <Lozenge appearance={appearance.a}>{appearance.t}</Lozenge>}
        </Inline>
      </Stack>
    </Box>
  );
}

function verdict(c) {
  if (c === null || c === undefined) return null;
  if (c >= 85) return { t: 'Ready', a: 'success' };
  if (c >= 60) return { t: 'Some drift', a: 'inprogress' };
  return { t: 'Significant drift', a: 'removed' };
}

function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [site, setSite] = useState('');
  const [busy, setBusy] = useState(null);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      setData(await invoke('projectOverview'));
      setError(null);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, []);

  useEffect(() => {
    load();
    view.getContext().then((c) => setSite(c.siteUrl || '')).catch(() => {});
  }, [load]);

  const running = data?.rows?.some((r) => r.job === 'queued' || r.job === 'running');
  useEffect(() => {
    clearTimeout(timer.current);
    if (running) timer.current = setTimeout(load, 4000);
    return () => clearTimeout(timer.current);
  }, [data, running, load]);

  const check = async (key) => {
    setBusy(key);
    try {
      await invoke('startFor', { issueKey: key });
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) return <SectionMessage appearance="error" title="Driftwise could not load">{error}</SectionMessage>;
  if (!data) return <Spinner size="large" />;

  const { rows, totals, overall, spend } = data;
  const checked = rows.filter((r) => r.confidence !== null);
  const v = verdict(overall);

  const head = {
    cells: [
      { key: 'item', content: 'Epic / work item', isSortable: true },
      { key: 'spec', content: 'Spec' },
      { key: 'conf', content: 'Spec confidence', isSortable: true },
      { key: 'drift', content: 'Drift' },
      { key: 'when', content: 'Checked' },
      { key: 'act', content: '' },
    ],
  };

  const tableRows = rows.map((r) => {
    const rv = verdict(r.confidence);
    const isRunning = r.job === 'queued' || r.job === 'running';
    return {
      key: r.key,
      cells: [
        {
          key: 'item',
          content: (
            <Stack space="space.0">
              <Link href={`${site}/browse/${r.key}`}>{r.key}</Link>
              <Text size="small">{r.summary}</Text>
            </Stack>
          ),
        },
        {
          key: 'spec',
          content: r.spec.length
            ? <Stack space="space.0">{r.spec.map((s) => <Link key={s.url} href={s.url} openNewTab>{s.title}</Link>)}</Stack>
            : <Text color="color.text.subtle">{r.state === 'no-spec' ? 'No spec linked' : '—'}</Text>,
        },
        {
          key: 'conf',
          content: r.confidence === null ? <Text color="color.text.subtle">Not checked</Text> : (
            <Stack space="space.050">
              <Inline space="space.100" alignBlock="center">
                <Text weight="semibold">{r.confidence}%</Text>
                <Lozenge appearance={rv.a}>{rv.t}</Lozenge>
              </Inline>
              <ProgressBar value={r.confidence / 100} appearance={r.confidence >= 85 ? 'success' : 'default'} ariaLabel={`${r.key} confidence`} />
            </Stack>
          ),
        },
        {
          key: 'drift',
          content: r.counts ? (
            <Inline space="space.050" shouldWrap>
              {r.counts.contradicted > 0 && <Lozenge appearance="removed">{r.counts.contradicted} contradicted</Lozenge>}
              {r.counts.missing > 0 && <Lozenge appearance="moved">{r.counts.missing} not planned</Lozenge>}
              {r.counts.partial > 0 && <Lozenge appearance="inprogress">{r.counts.partial} partial</Lozenge>}
              {r.outOfSpec > 0 && <Lozenge appearance="discovery">{r.outOfSpec} not in spec</Lozenge>}
              {!r.counts.contradicted && !r.counts.missing && !r.counts.partial && <Lozenge appearance="success">No drift</Lozenge>}
            </Inline>
          ) : <Text color="color.text.subtle">—</Text>,
        },
        { key: 'when', content: <Text size="small">{ago(r.analyzedAt)}</Text> },
        {
          key: 'act',
          content: isRunning
            ? <Inline space="space.050" alignBlock="center"><Spinner size="small" /><Text size="small">Checking…</Text></Inline>
            : (
              <LoadingButton spacing="compact" isLoading={busy === r.key} onClick={() => check(r.key)}>
                {r.confidence === null ? 'Check' : 'Re-check'}
              </LoadingButton>
            ),
        },
      ],
    };
  });

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Heading size="xlarge">Ship with confidence</Heading>
        <Text color="color.text.subtle">
          How closely the work planned in {data.projectKey} follows its Confluence specs. Open any epic to see each requirement, the exact quotes behind it, and one-click fixes.
        </Text>
      </Stack>

      <Inline space="space.200" shouldWrap>
        <Tile label="Overall spec confidence" value={overall === null ? '—' : `${overall}%`} appearance={v} />
        <Tile label="Contradicted requirements" value={totals.contradicted} />
        <Tile label="Requirements not planned" value={totals.missing} />
        <Tile label="Partly covered" value={totals.partial} />
        <Tile label="Epics checked" value={`${checked.length}/${rows.length}`} />
      </Inline>

      {totals.contradicted > 0 && (
        <SectionMessage appearance="warning" title={`${totals.contradicted} requirement${totals.contradicted > 1 ? 's are' : ' is'} contradicted by planned work`}>
          <Text>These are the riskiest: the team is building something different from what the spec promises. Resolve them before the release goes out.</Text>
        </SectionMessage>
      )}

      <DynamicTable
        caption="Epics and their specs"
        head={head}
        rows={tableRows}
        rowsPerPage={15}
        emptyView="No epics in this space yet."
      />

      <Text size="small" color="color.text.subtle">
        AI usage this month: US${spend.usd.toFixed(2)} of a US${spend.budget} cap. Driftwise stops calling the model when the cap is reached.
      </Text>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
