# Driftwise privacy policy

_Last updated: 2 November 2026_

Driftwise is a Forge app for Jira and Confluence. It runs entirely on Atlassian's Forge platform ("Runs on Atlassian"): it has no servers of its own and sends no data outside Atlassian.

## What Driftwise reads
When someone opens Driftwise or asks the Driftwise Rovo agent to check a Jira work item, Driftwise reads, with that person's permissions:
- the work item, its child work items and recent comments;
- the Confluence pages linked to it as its specification.

## What Driftwise stores
In Forge storage on your site, Driftwise keeps:
- the latest analysis for each checked work item (requirements, short quotes from the spec and the work items, the verdict and the time of the check);
- which findings people dismissed or acted on, and the keys of work items Driftwise created;
- the app's own monthly AI usage total.

Driftwise does not store Atlassian account IDs, names or email addresses, and does not track individual users.

## AI processing
Driftwise sends the spec text and the work item text to Atlassian-hosted large language models through the Forge LLMs API. Atlassian processes this under its own terms; the text is not used by Driftwise for anything other than producing the analysis shown to you.

## Sharing
Driftwise does not sell, share or transfer data to anyone.

## Deleting data
Uninstalling Driftwise removes its Forge storage from your site, as Forge does for every app.

## Contact
Questions: nicklau@opengemai.com or open an issue at https://github.com/steven6b16/driftwise.
