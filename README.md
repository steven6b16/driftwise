# Driftwise — ship what you specced

Driftwise is a Forge app for **Jira and Confluence** that catches *spec drift* before you ship: it reads the Confluence spec linked to a Jira epic, checks every requirement against the planned work, and shows you — with quotes you can verify — what is **contradicted**, **not planned**, **partly covered**, or **built but not in the spec**. Then it fixes the gaps in one click.

Built for **Codegeist 2026: Build with context. Ship with confidence.**

## Why

Specs live in Confluence. Work lives in Jira. They drift apart quietly: a story says "require sign-up" when the PRD promised guest checkout; an email is "batched every 15 minutes" when the spec says "within 60 seconds"; nobody created the accessibility story at all. These gaps are usually found in QA or by customers. Driftwise finds them while the work is still being planned.

## What it does

| Where | What you get |
| --- | --- |
| **Jira work item panel** | A spec-confidence score, every requirement judged against the epic and its child items, side-by-side quotes ("Spec says" / "SCRUM-2 says"), and one-click fixes: add the suggested acceptance criterion, create the missing work item, ask the open question in comments. |
| **Jira project page — "Ship with confidence"** | Every epic in the space with its spec, confidence and drift counts, worst first. |
| **Confluence page byline** | On the spec itself: which Jira work follows this page and how closely. |
| **Rovo agent "Driftwise"** | Ask "Is this epic ready to ship against its spec?" in Rovo chat. The agent reads the drift report, answers questions about the spec, and — when you agree — adds acceptance criteria or creates work items. |
| **Spec discovery** | No spec linked? Driftwise suggests the likely spec using Teamwork Graph (pages in Confluence spaces linked to the Jira space), with a title-search fallback. |

## Built to be trusted

- **Every quote is checked.** The model must quote the spec and the Jira text; Driftwise verifies each quote against the source text and labels it *verified quote* or *check wording*.
- **Permissions respected.** Every user-facing call first reads the work item as the user; actions run as the user.
- **Runs on Atlassian.** No external servers. AI runs through the Forge LLMs API (Claude); data stays in Forge storage.
- **Stale detection.** If the spec page or the work changes after a check, Driftwise says so and offers a re-check.
- **Cost guard.** AI spend is tracked per installation and capped monthly; the app stops calling the model when the cap is reached.

## How it works

```
Jira issue panel / project page / Confluence byline / Rovo action
        │  (resolver, runs as the user)
        ▼
  queue: driftwise-analysis ──► worker (async, up to 300 s)
        │                         ├─ read epic + children + comments (Jira REST)
        │                         ├─ read linked spec pages (Confluence REST v2)
        │                         ├─ Forge LLMs (Claude) → structured JSON
        │                         ├─ verify every quote against source text
        │                         └─ score + store in Forge KVS (with fingerprint)
        ▼
  UI polls state, shows findings, offers fixes (Jira REST as the user)
```

Key files: `src/lib/analysis.js` (prompt, scoring, quote verification), `src/lib/text.js` (ADF/storage parsing, quote matching), `src/lib/graph.js` (Teamwork Graph), `src/rovo.js` (Rovo actions), `src/frontend/*` (UI Kit).

## Try it

1. Install Driftwise on your site (Jira, plus Confluence for the byline).
2. Open an epic that links its Confluence spec (a web link or a URL in the description).
3. Open the **Driftwise** panel and select **Check against spec**.

## Develop

```bash
npm install -g @forge/cli
npm install
forge register      # creates your own app id
forge deploy
forge install --product jira
forge install --product confluence
```

## Legal

- [Privacy policy](PRIVACY.md)
- [Terms of use](TERMS.md)
- License: MIT
