import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box, Heading, Inline, Link, Lozenge, ProgressBar, SectionMessage, Spinner, Stack, Text, xcss,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';

const row = xcss({
  paddingBlock: 'space.100',
  borderBottomWidth: 'border.width',
  borderBottomStyle: 'solid',
  borderBottomColor: 'color.border',
});

function verdict(c) {
  if (c >= 85) return { t: 'Ready', a: 'success' };
  if (c >= 60) return { t: 'Some drift', a: 'inprogress' };
  return { t: 'Significant drift', a: 'removed' };
}

function App() {
  const [data, setData] = useState(null);
  const [site, setSite] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    invoke('pageCoverage').then(setData).catch((e) => setError(String(e.message || e)));
    view.getContext().then((c) => setSite(c.siteUrl || '')).catch(() => {});
  }, []);

  if (error) return <SectionMessage appearance="error">{error}</SectionMessage>;
  if (!data) return <Spinner size="medium" />;

  const items = data.items.filter((i) => i.confidence !== null);
  if (!items.length) {
    return (
      <Box xcss={xcss({ padding: 'space.200', maxWidth: '360px' })}>
        <Stack space="space.100">
          <Heading size="small">Driftwise</Heading>
          <Text>No Jira work has been checked against this page yet.</Text>
          <Text size="small" color="color.text.subtle">Link this page to an epic and open Driftwise on it to see how closely the planned work follows this spec.</Text>
        </Stack>
      </Box>
    );
  }

  return (
    <Box xcss={xcss({ padding: 'space.200', width: '380px' })}>
      <Stack space="space.150">
        <Stack space="space.050">
          <Heading size="small">How Jira work follows this spec</Heading>
          <Text size="small" color="color.text.subtle">{items.length} work item{items.length > 1 ? 's' : ''} checked against this page</Text>
        </Stack>
        {items.map((i) => {
          const v = verdict(i.confidence);
          return (
            <Box key={i.key} xcss={row}>
              <Stack space="space.075">
                <Inline spread="space-between" alignBlock="center">
                  <Link href={`${site}/browse/${i.key}`} openNewTab>{i.key} · {i.summary}</Link>
                  <Lozenge appearance={v.a}>{i.confidence}%</Lozenge>
                </Inline>
                <ProgressBar value={i.confidence / 100} appearance={i.confidence >= 85 ? 'success' : 'default'} ariaLabel={`${i.key} confidence`} />
                <Inline space="space.050" shouldWrap>
                  {i.counts.contradicted > 0 && <Lozenge appearance="removed">{i.counts.contradicted} contradicted</Lozenge>}
                  {i.counts.missing > 0 && <Lozenge appearance="moved">{i.counts.missing} not planned</Lozenge>}
                  {i.counts.partial > 0 && <Lozenge appearance="inprogress">{i.counts.partial} partial</Lozenge>}
                </Inline>
              </Stack>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
