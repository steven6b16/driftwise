import { chat, list } from '@forge/llm';
import { kvs } from '@forge/kvs';

// USD per 1M tokens by model class, from the Forge LLMs pricing page.
const PRICES = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 3, out: 15 },
  opus: { in: 5, out: 25 },
};
export const MONTHLY_BUDGET_USD = Number(process.env.DRIFTWISE_MONTHLY_BUDGET_USD || 25);

const monthKey = () => `budget:${new Date().toISOString().slice(0, 7)}`;

export async function getSpend() {
  return (await kvs.get(monthKey())) || { usd: 0, calls: 0 };
}

async function recordSpend(model, usage) {
  const cls = /opus/.test(model) ? 'opus' : /haiku/.test(model) ? 'haiku' : 'sonnet';
  const p = PRICES[cls];
  const usd = ((usage?.input_tokens || 0) * p.in + (usage?.output_tokens || 0) * p.out) / 1e6;
  const cur = await getSpend();
  await kvs.set(monthKey(), { usd: cur.usd + usd, calls: cur.calls + 1 });
  return usd;
}

export async function budgetLeft() {
  const s = await getSpend();
  return MONTHLY_BUDGET_USD - s.usd;
}

let cachedModels;
async function pickModel(preferred) {
  if (!cachedModels) {
    try {
      cachedModels = ((await list()).models || []).filter((m) => m.status === 'active').map((m) => m.model);
    } catch {
      cachedModels = [];
    }
  }
  const prefs = preferred === 'fast'
    ? ['claude-haiku-4-5-20251001', 'haiku']
    : ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'sonnet'];
  for (const p of prefs) {
    const hit = cachedModels.find((m) => m === p) || cachedModels.find((m) => m.includes(p));
    if (hit) return hit;
  }
  return cachedModels[0] || 'claude-sonnet-4-5-20250929';
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

export async function completeJson({ system, user, maxTokens = 4000, speed = 'quality' }) {
  if ((await budgetLeft()) <= 0) {
    const e = new Error(`Monthly AI budget of US$${MONTHLY_BUDGET_USD} reached`);
    e.code = 'BUDGET';
    throw e;
  }
  const model = await pickModel(speed);
  const res = await chat({
    model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: system }] },
      { role: 'user', content: [{ type: 'text', text: user }] },
    ],
    max_completion_tokens: maxTokens,
  });
  const usd = await recordSpend(model, res.usage);
  const text = (res.choices?.[0]?.message?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
  return { data: extractJson(text), model, usd, usage: res.usage };
}
