# Deribit Depth

A local trading UI for Deribit Testnet with real-time order book, one-click ordering, Block RFQ, and a live blotter.

## Setup on a new computer

### 1. Install prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Git](https://git-scm.com/)

### 2. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
cd YOUR_REPO_NAME
```

### 3. Install dependencies

```bash
npm install
```

### 4. Configure the environment

Copy the example env file and fill it in:

```bash
cp .env.example .env
```

Open `.env` and set `ENCRYPTION_KEY` to a random 64-character hex string. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> Keep this key safe and consistent — changing it will invalidate any stored API keys.

### 5. Start the server

Double-click `start-server.bat`, or run:

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

## Saving your work

Run `save.sh` (double-click it in File Explorer, or run it in Git Bash) to commit and push all changes to GitHub.

## Notes

- API keys are stored encrypted in `keys_store.json` — this file is **not** committed to git. Back it up separately if needed.
- `.env` is also excluded from git. Keep a copy somewhere safe.
- The app connects directly to `test.deribit.com` (Deribit Testnet). No real funds are used.
- Block RFQ requires your Deribit API key to have the `block_rfq:read_write` scope.
