# Installing CFactory

If the user gives you this repository and asks you to install or run it, follow `AGENTS.md` exactly. The short path is:

```bash
npm run setup
npm start
```

Open `http://127.0.0.1:4312`, then connect Higgsfield from Settings using OAuth. The user may optionally add an OpenAI key, a Claude key, or both in Settings for script writing. Never ask the user to paste any key into chat, and never start a paid render as an installation test.

Confirm the app through `/api/health`. A product render needs at least one product photo. When a card shows **Unknown**, choose **Recover render** to reconcile the existing Higgsfield job instead of submitting another paid generation.
