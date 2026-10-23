# CFactory agent instructions

When the user asks you to install or run this repository:

1. Confirm Node.js 20.11 or newer is available.
2. Run `npm run setup` from the repository root.
3. Run `npm start` and keep the process alive.
4. Tell the user to open `http://127.0.0.1:4312`.
5. In CFactory Settings, connect Higgsfield with OAuth.

Do not ask for a Higgsfield API key or access token. The official MCP connection is `https://mcp.higgsfield.ai/mcp` and authenticates through OAuth. OpenAI and Anthropic are optional script-writing providers: users add their own keys in the local Settings screen or `.env.local`. Never ask a user to paste a secret into chat, never print a key, and never commit `.env.local` or `.data/settings.json`.

Before changing source code, preserve `.data/` and run `npm run check` after the change. Never trigger a paid video render merely to test the installation.

After startup, verify `http://127.0.0.1:4312/api/health`. Product renders require at least one photo. If a paid render is `Unknown`, use the recovery endpoint or **Recover render** button; never retry `generate_video` until the existing job has been reconciled.
