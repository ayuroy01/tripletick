# Contributing

Thanks for helping. Bug fixes, new channel adapters, themes, translations and docs are all welcome.

## Setup

```bash
npm install
npm run dev        # API on :4310, web on :5173, with reload
```

Sign in with `demo@tripletick.local` / `tripletick`. The **Simulator** plays the customer, so you don't need a Meta account.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run e2e        # against a running `npm run demo`, needs Google Chrome
```

Keep pull requests focused on one change and describe how you tested it.

## Ground rules

- Use the official WhatsApp Cloud API only. Pull requests that automate WhatsApp Web won't be merged, because that breaks WhatsApp's terms and gets numbers banned.
- Don't weaken the guardrails (the 24-hour window, opt-out handling, broadcast consent and rate limits).
- New themes must pass WCAG AA contrast. The theme tests check this.
- Demo data must be clearly fictional.

## Adding a channel

Implement the `ChannelAdapter` interface in `server/src/channels/` and register it in `server/src/channels/index.ts`. The simulator adapter is the smallest example.
