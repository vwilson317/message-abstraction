# message-abstraction

Conversation insights beside the messaging apps you already use: **WhatsApp Desktop on
your Mac** and **Instagram in Chrome**. No APIs and no second client. Inbox reads what
those apps already have on your computer and shows it in a panel next to them. You keep
chatting in the apps.

- **WhatsApp Desktop (Mac):** reads the app's own local database, read-only, while it
  runs. New messages, edits and deletes show up within a couple of seconds.
- **Instagram (Chrome):** a small extension reads the conversation you have open, straight
  from the page, and puts a side panel next to it.
- **Groups:** Close friends, Romantic interests, Dates and Ghosts, each with its own
  metrics and alert setting. Press and hold a conversation to move it.
- **Insights:** who talks more, who reaches out first, reply times, when you talk, how it
  changes month to month. Plus a one-click, LLM-ready transcript of any range. This panel
  is where the AI assistant will plug in.
- **Imports:** WhatsApp chat exports and Instagram data downloads, for history the apps
  don't hold.

Everything stays on your machine: one Node process, one SQLite file, one unpacked
extension.

> **Status:** first cut of the app-overlay approach. The LLM layer is next. See
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how each app is read and why.

## Quick start

On the Mac where WhatsApp Desktop is installed and signed in, with Node.js 22.16 or newer:

```bash
npm install
npm run build        # builds the web app and the Chrome extension
npm start            # http://localhost:4310
```

### WhatsApp Desktop

Starting the server begins reading WhatsApp Desktop's data. The first time, macOS asks
whether your terminal may **access data from other apps**. Click **Allow**.

That permission lasts only as long as that process runs. To stop the prompt for good,
give the app you start the server from (Terminal, iTerm, …) **Full Disk Access** in
System Settings → Privacy & Security, then restart it. The Sources dialog has a button
that opens the right pane.

Then click **Companion** in the sidebar. It opens a narrow window to keep beside WhatsApp:

- **Follow** switches the companion to whichever chat you send a message in.
- **Float** keeps it above other apps. This uses Chrome's Picture-in-Picture for pages,
  so there's nothing to install.

### Instagram

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and
   choose `dist/extension`.
2. Open a conversation at `instagram.com/direct`.
3. Click the Inbox icon in Chrome's toolbar to open the side panel next to the chat.

Instagram only shows about 20 messages at a time. Scroll up in the conversation to bring
older ones in, or use **Read earlier messages** in the panel. That button scrolls the
conversation for you, slowly; it's the one time the extension touches the page, and only
when you click it.

### Import exports

Use **Sources → Import**, or the CLI for big files and folders:

```bash
npm run import -- "WhatsApp Chat with Alice.zip"
npm run import -- ~/Downloads/instagram-yourname-2026-10-01.zip
npm run import -- chat.txt --self "Your Name" --date-order MDY
```

- **WhatsApp:** open the chat on your phone → Export chat. "Attach media" brings the
  photos along.
- **Instagram:** Accounts Center → Your information and permissions → Download your
  information → Messages, format **JSON**.

## Groups

Tabs at the top of the inbox sort conversations into four groups. Press and hold a
conversation (or right-click it, or press Shift+F10) to move it.

| Group                  | Who's in it                                                                                                                      | Alerts | What it measures                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Close friends**      | Everyone, until you move them                                                                                                    | On     | Keeping in touch: when you last talked, your usual gap (and a flag when it's running long), who reaches out, messages a week, streaks                    |
| **Romantic interests** | People you move here                                                                                                             | Off    | Interest signals over 30 days: who starts conversations, reply times both ways, whether theirs are speeding up, words, questions, double texts, momentum |
| **Dates**              | A romantic interest you've scheduled a date with, from the move menu. They return to Romantic interests 12 hours after it starts | On     | The lead-up: countdown, messages and who's reached out since you scheduled it, how busy the chat is now compared with before                             |
| **Ghosts**             | Romantic interests where neither of you has written for 48 hours, or that you moved here by hand (until someone writes again)    | Off    | The silence: how long, who's waiting on whom, how many messages went unanswered, how fast they usually replied, how it ended                             |

Romantic interests and Ghosts are muted: no desktop alerts and no unread badges. The bell
next to the tabs turns alerts on or off for each group. Desktop alerts come from an open
Inbox or Companion window, not from the apps themselves, which keep their own
notifications. A date counts as contact, so someone you just had a date with doesn't
become a ghost. Search looks across every group.

## Configuration

All optional. Put them in `.env` or your shell; see [`.env.example`](.env.example).

| Variable             | Default                    | What it does                                                          |
| -------------------- | -------------------------- | --------------------------------------------------------------------- |
| `PORT` / `HOST`      | `4310` / `127.0.0.1`       | Where the server listens                                              |
| `ALLOWED_HOSTS`      | none                       | Extra host names to answer to                                         |
| `DATA_DIR`           | `./data`                   | Inbox's own database and imported media                               |
| `MAX_UPLOAD_MB`      | `512`                      | Upload limit for the web importer                                     |
| `WHATSAPP_CONTAINER` | WhatsApp's group container | Where to find WhatsApp Desktop's data (set this to try it off a Mac)  |
| `WHATSAPP_POLL_MS`   | `1500`                     | How often to check WhatsApp's database for changes                    |
| `EXTENSION_ID`       | any                        | Only accept captures from this extension id (see chrome://extensions) |

## Privacy and what it touches

- **No network calls to WhatsApp or Instagram,** and nothing is ever sent. Inbox reads
  your own data on your own computer.
- **WhatsApp:** the database is opened read-only, with short reads so WhatsApp's own
  writes are never held up. Like any SQLite reader, it records read marks in WhatsApp's
  `-shm` file; it never writes to the database itself. Crypto material (`Axolotl.sqlite`
  and the like) is never opened.
- **Instagram:** the extension reads the page's visible text and image addresses. It
  makes no requests of its own and doesn't change Instagram's page. Captures go from the
  extension's background worker to `localhost`, never from instagram.com.
- **The server** listens on `127.0.0.1` only. It refuses unexpected `Host` headers (DNS
  rebinding) and cross-site writes (CSRF). The extension's origin is accepted only on the
  two capture routes. Only the app itself and the extension may frame its pages, and
  other websites can't embed its media. There is no login, so don't expose it to a
  network.
- `data/` holds your messages: treat it like a password.

**Terms of service.** WhatsApp and Instagram don't offer this kind of access, and
Instagram's terms forbid collecting information "in an automated way". Passive reading of
your own screen is the low end of that. **Read earlier messages** automates scrolling, so
it's opt-in.

## Limits worth knowing

- **WhatsApp Desktop holds what WhatsApp synced to the Mac,** which may not be your whole
  history. Most media is never downloaded. For older history, import an export from your
  phone.
- **WhatsApp's database layout is private** and can change with an update. Inbox checks
  for the columns it needs and refuses to read a layout it doesn't recognise, rather
  than misreading it.
- **Instagram's page is read by structure and position:**
  - Your own messages are the ones on the right. That assumes a left-to-right UI language.
  - Times come only from Instagram's occasional date dividers, in English. Between
    dividers, message order is exact but times are approximate, so reply-time stats skip
    them. A message that arrives while you watch is dated when it arrives.
  - A conversation counts as a group chat once the page shows more than one other person
    in it, and it stays one.
  - View-once messages can't be seen on the web at all.

## Development

```bash
npm run dev          # API on :4310, web UI with hot reload on :5173
npm test             # vitest
npm run typecheck    # server, web and extension
npm run format       # prettier
```

```
src/
  core/                 domain types, source contract, the hub, media store
  connectors/
    whatsapp-mac/       WhatsApp Desktop's ChatStorage.sqlite reader
    browser/            receives extension captures; aligns on-screen slices into history
  importers/            export parsers (WhatsApp .txt, Instagram JSON)
  insights/             conversation stats and LLM-ready transcripts
  store/                SQLite persistence (node:sqlite, no native deps)
  server/               HTTP API + server-sent events (Hono)
  cli/                  npm run import
extension/              Chrome MV3 extension: Instagram reader, side panel
web/src/                React app: inbox, companion view
tests/                  unit, DOM and API tests with hand-built fixtures
```
