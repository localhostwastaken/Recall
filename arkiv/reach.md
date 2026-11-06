# Reach

## Who is it for, and would they use it?

**Journalists and researchers** who need to show that an official page said something on a date
after it has been quietly edited or taken down: exam and admission deadlines, government notices,
company policies, terms of service, price lists, press releases. Today they rely on screenshots
(easy to fake, easy to dispute) or on a single archive service (one organisation that can be asked
to remove a page, and that only captures what it chooses to crawl).

Recall gives them a capture that **anyone can check without trusting the person who made it**: you
trust the witness key you pin, and by default that is ours. The TLS session was witnessed, the
evidence is content-addressed on Swarm, and the index is public and read-only on Arkiv.

Others who benefit from the same records:
- **Readers and editors** checking a story: they open a link and see the checks pass, no wallet or
  account needed.
- **Fact-checkers and archivists**, who can query any URL's history on Arkiv and add their own
  captures and confirmations.
- **Students and applicants**: our demo is exactly their case, a university notice whose deadline
  moves from "15 December" to "12 December".
- **Other apps**: any site can show "captured versions" next to a link with one Arkiv query by
  `urlHash`, with no API key from us.

## Can they try it today?

Yes:
- **Verify (no install, no wallet):** open <https://localhostwastaken.github.io/Recall/app/> and look
  up `https://localhostwastaken.github.io/Recall/notice/?run=0tzgmo55`, or run `pnpm arkiv:query`.
- **Capture:** load the extension (`pnpm extension:zip`, then "Load unpacked" in developer mode),
  paste its ID into the app's Settings, get a little tGLM from <https://hub.arkiv.network/faucet>,
  and buy a postage batch on the app's Storage page (xBZZ on Gnosis; there is no public xBZZ
  faucet). Full steps: [README, Run it](../README.md#run-it).
- **Run your own witness** from `witness/` and announce it on Arkiv (see the README).

Today's real numbers, honestly: one developer and three non-coding teammates capturing and
verifying at ETHGlobal Mumbai; live captures on Rabdi so far are our test captures of the demo
notice (see [docs/evidence-log.md](../docs/evidence-log.md)).

## How it spreads

- **Every capture is a link.** `https://localhostwastaken.github.io/Recall/app/#/c/<entityKey>`
  opens straight to a verified view, so a capture spreads with the story that cites it.
- **Every capture is a file.** The evidence file can be downloaded, attached or emailed, and dropped
  into any copy of the app, even offline.
- **Readers can keep captures alive.** Anyone who cares about a capture can extend it, so the
  people who need a record are the ones who keep it.
- **The index is open.** Other tools can read and write `recall.v1.capture` rows; more witnesses
  can join, and readers pick which ones they trust.

## After Mumbai

We will keep building Recall (it was planned as an MVP to continue after the hackathon):
- more independent witnesses, and a TEE-backed witness, so no single operator is needed;
- the Chrome Web Store, so capturing does not need developer mode;
- TLS 1.3 and larger pages as TLSNotary supports them;
- Arkiv mainnet when it is available.
