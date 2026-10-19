# message-abstraction

One inbox over WhatsApp and Instagram DMs, with room for conversation insights
next to the chat, so you don't have to export transcripts and read them somewhere else.

- **WhatsApp, live.** Link it like WhatsApp Web (scan a QR code). Read, reply, and see
  history sync in.
- **WhatsApp and Instagram, imported.** Drop in a chat export (`.txt`/`.zip` from
  WhatsApp, the JSON "Download your information" export from Instagram) and read it
  in the same interface.
- **Insights panel.** Who talks more, who reaches out first, reply times, when you talk,
  how it changes month to month. Plus a one-click, LLM-ready transcript for any range.
  This panel is where the AI assistant will plug in.

Everything runs and stays on your machine: one Node process, one SQLite file.

> **Status:** first cut. Instagram is import-only for now (see
> [the trade-offs](docs/ARCHITECTURE.md#platform-access)), and the LLM layer is the
> next step. Live WhatsApp uses an unofficial client; read [the caveat](#a-note-on-whatsapp).

## Quick start

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev          # API on :4310, web UI on http://localhost:5173
```

Or as a single server:

```bash
npm run build
npm start            # http://localhost:4310
```

### Connect WhatsApp

Open **Accounts → WhatsApp → Connect**, then on your phone go to
**Settings → Linked devices → Link a device** and scan the code. Recent history syncs
in over the next minute or two. The session is saved in `data/connectors/whatsapp/auth`,
so restarts reconnect on their own. **Unlink** removes it from your phone and deletes
the credentials.

### Import exports

Use **Import** in the sidebar, or the CLI for big files and folders:

```bash
npm run import -- "WhatsApp Chat with Alice.zip"
npm run import -- ~/Downloads/instagram-yourname-2026-10-01.zip
npm run import -- ~/Downloads/instagram-export/          # an extracted folder works too
npm run import -- chat.txt --self "Your Name" --date-order MDY
```

- **WhatsApp:** open the chat → Export chat. "Attach media" brings the photos along.
  iOS and Android formats, 12/24-hour clocks and day/month order are detected.
- **Instagram:** Settings → Accounts Center → Your information and permissions →
  Download your information → Messages, format **JSON**.

Re-importing a newer export of the same chat merges into it instead of duplicating.
If the importer can't tell which participant is you, the insights panel asks.

## Configuration

All optional; see [`.env.example`](.env.example).

| Variable                     | Default              | What it does                                                   |
| ---------------------------- | -------------------- | -------------------------------------------------------------- |
| `PORT` / `HOST`              | `4310` / `127.0.0.1` | Where the API listens                                          |
| `ALLOWED_HOSTS`              | —                    | Extra host names to answer to (e.g. a Tailscale name)          |
| `DATA_DIR`                   | `./data`             | Database, media and credentials                                |
| `MAX_UPLOAD_MB`              | `512`                | Upload limit for the web importer                              |
| `WHATSAPP_SYNC_FULL_HISTORY` | `true`               | Ask the phone for full history when linking                    |
| `WHATSAPP_AUTO_DOWNLOAD_MB`  | `16`                 | Auto-download live images, stickers and voice notes up to this |
| `WHATSAPP_LOG_LEVEL`         | `silent`             | Baileys logging, for troubleshooting                           |

## Privacy and security

This server can read and send your messages, so:

- It listens on `127.0.0.1` only, and refuses requests with unexpected `Host` headers
  (DNS rebinding) or cross-site origins (CSRF). There is no login, so don't expose it
  to a network without putting authentication in front.
- `data/` holds your messages, media and WhatsApp session keys. It is git-ignored;
  treat it like a password.
- Media is served sandboxed (`Content-Security-Policy: sandbox`, `nosniff`).

## A note on WhatsApp

WhatsApp's official API only works for business numbers, so personal accounts are
linked through [Baileys](https://github.com/WhiskeySockets/Baileys), an open-source
WhatsApp Web client. WhatsApp's terms don't allow unofficial clients. For ordinary
personal use bans are rare, but they do happen, mostly to accounts that send in bulk.
The app never sends anything you didn't type. Reading a chat here does not send read
receipts.

## Development

```bash
npm test             # vitest
npm run typecheck    # tsc
npm run format       # prettier
```

```
src/
  core/          domain types, connector contract, the hub, media store
  connectors/    live services (whatsapp/ via Baileys)
  importers/     export parsers (WhatsApp .txt, Instagram JSON) and the import pipeline
  insights/      conversation stats and LLM-ready transcripts
  store/         SQLite persistence (node:sqlite, no native deps)
  server/        HTTP API + server-sent events (Hono)
  cli/           npm run import
web/src/         React client
tests/           unit and API tests with hand-written export fixtures
```

How it fits together, the options for each platform, and the plan for the LLM layer:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
