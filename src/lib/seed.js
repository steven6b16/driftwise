import api, { route } from '@forge/api';
import {
  createIssueRaw, createPage, createSpace, findPageByTitle, getIssueTypes, listSpaces, searchIssues,
} from './atlassian';

const PRD_TITLE = 'Checkout v2 — Product requirements';

const PRD = `
<p><strong>Owner:</strong> Product · <strong>Status:</strong> Approved · <strong>Target release:</strong> Checkout v2</p>
<h2>Goal</h2>
<p>Reduce checkout abandonment from 38% to under 25% by removing friction for first-time buyers and making payment failures recoverable.</p>
<h2>Requirements</h2>
<ol>
<li><strong>Guest checkout.</strong> Customers must be able to complete checkout without creating an account. Account creation may be offered after the order is placed.</li>
<li><strong>Payment methods.</strong> Support credit and debit cards, Apple Pay and Google Pay at launch.</li>
<li><strong>Address autocomplete.</strong> Shipping address entry uses autocomplete for Hong Kong, Singapore and the United Kingdom at launch.</li>
<li><strong>Promo codes.</strong> One promo code per order. Codes are validated server-side and an invalid code shows an error message within 1 second.</li>
<li><strong>Order confirmation.</strong> The order confirmation email must be sent within 60 seconds of a successful payment.</li>
<li><strong>Inventory hold.</strong> Stock is reserved for 10 minutes once the customer reaches the payment step, then released.</li>
<li><strong>Accessibility.</strong> The full checkout flow must meet WCAG 2.2 AA.</li>
<li><strong>Failed payments.</strong> A customer can retry a failed payment up to 3 times; the cart is preserved between attempts.</li>
<li><strong>Analytics.</strong> Emit the events checkout_started, payment_submitted and order_completed.</li>
</ol>
<h2>Out of scope for v2</h2>
<ul>
<li>PayPal</li>
<li>Loyalty points</li>
<li>Saved cards</li>
</ul>
<h2>Notes</h2>
<p>Show an estimated delivery date where possible.</p>
`;

const STORIES = [
  {
    summary: 'Guest checkout flow',
    description: 'Allow checkout for signed-in customers. Customers without an account are redirected to the sign-up page before they can pay, so we can attach every order to an account.',
  },
  {
    summary: 'Card and wallet payments',
    description: 'Integrate the payment provider for credit and debit cards, Apple Pay, Google Pay and PayPal on the payment step.',
  },
  {
    summary: 'Promo code field on payment step',
    description: 'Add a promo code input to the payment step. Validate the code and show an error if it is invalid. Customers can stack multiple codes.',
  },
  {
    summary: 'Order confirmation email',
    description: 'Send the order confirmation email after the order is placed, using the existing email template service (batched every 15 minutes).',
  },
  {
    summary: 'Payment retry handling',
    description: 'When a payment fails, let the customer retry up to 3 times. Keep the cart contents between attempts. After the third failure, cancel the order and show support contact details.',
  },
  {
    summary: 'Checkout analytics events',
    description: 'Emit checkout_started, payment_submitted and order_completed to our analytics pipeline with order value and payment method.',
  },
  {
    summary: 'Redeem loyalty points at checkout',
    description: 'Show the customer\'s loyalty point balance on the payment step and let them redeem points against the order total.',
  },
];

const adf = (text, url) => ({
  type: 'doc',
  version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text }] },
    ...(url ? [{ type: 'paragraph', content: [{ type: 'text', text: 'Spec: ' }, { type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }] }] : []),
  ],
});

async function pickProject(preferred) {
  const res = await api.asApp().requestJira(route`/rest/api/3/project/search?maxResults=50&orderBy=key`);
  const data = await res.json();
  const projects = (data.values || []).filter((x) => x.projectTypeKey === 'software');
  const first = projects.find((x) => x.key === preferred) || projects.find((x) => x.key === 'SCRUM');
  for (const p of [first, ...projects].filter(Boolean)) {
    const types = await getIssueTypes(p.key, 'app').catch(() => []);
    const epic = types.find((t) => t.hierarchyLevel === 1);
    const story = types.find((t) => t.hierarchyLevel === 0 && !t.subtask && /story/i.test(t.name))
      || types.find((t) => t.hierarchyLevel === 0 && !t.subtask && !/bug/i.test(t.name));
    if (epic && story) return { key: p.key, epicType: epic, storyType: story };
  }
  throw new Error('No software project with epics and stories found');
}

export async function seedDemo(mode, opts = {}) {
  const spaces = await listSpaces('app');
  let space = spaces.find((s) => s.type === 'global') || spaces[0];
  const label = { video: 'driftwise-video', sample: 'driftwise-sample' }[mode] || 'driftwise-demo';
  if (mode === 'video') {
    space = spaces.find((s) => s.key === 'SPECS');
    if (!space) space = await createSpace('SPECS', 'Product Specs', 'app');
  }
  if (mode === 'sample') {
    space = spaces.find((s) => s.key === 'DWSAMPLE');
    if (!space) space = await createSpace('DWSAMPLE', 'Driftwise sample specs', 'app');
  }
  if (!space) throw new Error('No Confluence space found');
  let page = await findPageByTitle(space.id, PRD_TITLE, 'app');
  if (!page) page = await createPage(space.id, PRD_TITLE, PRD, 'app');

  const { key: projectKey, epicType, storyType } = await pickProject(opts.projectKey);
  if (mode === 'unlinked') {
    const e = await createIssueRaw({
      project: { key: projectKey },
      issuetype: { id: epicType.id },
      summary: 'Checkout v2 – mobile app launch',
      labels: ['driftwise-demo'],
      description: adf('Ship the new checkout in the iOS and Android apps.'),
    }, 'app');
    return { unlinkedEpic: e.key };
  }
  const existing = await searchIssues(`project = ${projectKey} AND labels = ${label}`, 'app', 50);
  if (existing.length) {
    const top = await searchIssues(`project = ${projectKey} AND labels = ${label} AND parent IS EMPTY`, 'app', 5).catch(() => []);
    const epicHit = top[0] || existing[0];
    return { page, projectKey, note: 'already seeded', epic: epicHit.key, issues: existing.map((i) => i.key) };
  }


  const epic = await createIssueRaw({
    project: { key: projectKey },
    issuetype: { id: epicType.id },
    summary: 'Checkout v2',
    labels: [label],
    description: adf('Rebuild checkout to cut abandonment. Requirements live in the Confluence PRD.', page.url),
  }, 'app');

  await api.asApp().requestJira(route`/rest/api/3/issue/${epic.key}/remotelink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      globalId: `driftwise-page-${page.id}`,
      relationship: 'Specified by',
      object: { url: page.url, title: PRD_TITLE },
    }),
  });

  const created = [epic.key];
  for (const s of STORIES) {
    const issue = await createIssueRaw({
      project: { key: projectKey },
      issuetype: { id: storyType.id },
      summary: s.summary,
      labels: [label],
      parent: { key: epic.key },
      description: adf(s.description),
    }, 'app');
    created.push(issue.key);
  }
  return { page, projectKey, epic: epic.key, issues: created };
}
