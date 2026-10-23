# Install CFactory

## Fast path for a coding agent

Give the repository link to Codex, Claude Code, or another local coding agent and say:

> Clone this repository, follow its AGENTS.md or CLAUDE.md, install it, start it, and give me the local URL. Do not run a paid video generation.

The agent should run:

```bash
git clone REPOSITORY_URL cfactory-ugc
cd cfactory-ugc
npm run setup
npm start
```

Then open `http://127.0.0.1:4312` and select **Settings → Connect with OAuth**.

## Manual requirements

- macOS, Windows, or Linux
- Node.js 20.11 or newer
- npm 10 or newer
- An active Higgsfield account/subscription for MCP generations

Higgsfield uses OAuth and never needs an API key. The built-in AI script writer is optional: each user may connect OpenAI, Claude, or both from the local Settings screen. Keys remain on that computer and should never be pasted into an AI-agent conversation. OpenAI models are selected from those available to the connected project, with `gpt-6-luna` preferred for script writing; an optional `OPENAI_MODEL` setting may pin another available model.

At least one real product photo is required before a Higgsfield cost check or render. If a paid submission becomes **Unknown**, use **Recover render**; do not click Generate again. Recovery searches for the existing paid job and does not submit a replacement.

## Updating

From the repository folder:

```bash
git pull
npm run setup
```

Project cards and OAuth credentials live under `.data/` and are not replaced by setup or updates.
