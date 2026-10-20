# Architecture

Inbox sits on top of the messaging apps you already use. It reads what they show or
store on your computer, keeps it in one local database, and puts insights beside the
conversation you're in. It never talks to WhatsApp's or Instagram's servers and never
sends anything. You chat in the apps.

```mermaid
flowchart LR
  subgraph Your apps
    WAD[WhatsApp Desktop<br/>Mac app]
    IG[instagram.com<br/>Chrome tab]
  end
  WAD -- ChatStorage.sqlite<br/>read-only --> WAR[whatsapp-mac source]
  IG -- DOM, passive --> CS[content script] --> SW[extension<br/>service worker]
  SW -- captures --> BS[instagram-web source]
  EXP[Exports<br/>.txt / .zip / JSON] --> IMP[importers]
  WAR --> HUB[Hub<br/>ids, merging, events]
  BS --> HUB
  IMP --> HUB
  HUB --> DB[(SQLite)]
  HUB -- SSE --> UI
  subgraph UI[Views]
    INBOX[Inbox<br/>localhost:4310]
    COMP[Companion window<br/>beside WhatsApp]
    PANEL[Chrome side panel<br/>beside Instagram]
  end
  DB --> INS[Insights<br/>stats, transcripts] --> UI
  INS -.-> LLM[LLM assistant<br/>next]:::todo
  classDef todo stroke-dasharray: 4 4
```

## Core

**Domain model** (`src/core/types.ts`). `Conversation`, `Message`, `Participant`,
`Attachment`, `Reaction`, `ConnectorStatus`. A conversation has a `platform` and a
`sourceId` (which source produced it). Ids are namespaced `${sourceId}:${nativeId}`.
Live conversations list "You" as a participant with id `me`.

**Sources** (`src/core/connector.ts`). A source mirrors an app that is already running:
`shouldAutoStart`, `start`, `stop`. It may also serve the app's own media files
(`mediaFile`), or accept pushes from the extension (`receive`, `heartbeat`). A source
never touches the database. It reports `ConversationInput`, `MessageInput` and
`MessagePatch` to the hub.

**Hub** (`src/core/hub.ts`). The one writer. It creates conversations on first sight and
merges re-read messages without undoing edits or deletes. It mirrors an app's own unread
counts when the source knows them, and skips the write and the event when a re-read row
hasn't changed. Large batches emit one `messages.bulk` event.

**Store** (`src/store/db.ts`). SQLite through Node's built-in `node:sqlite`, so there's
nothing native to compile. Newest-first pagination uses a `timestamp_rowid` cursor.

**API** (`src/server/app.ts`). REST plus server-sent events. It binds to `127.0.0.1`,
rejects unknown `Host` headers and cross-site writes, and accepts the extension's
`chrome-extension://` origin only on `/api/connectors/:id/{captures,heartbeat}` (optionally
pinned with `EXTENSION_ID`). HTML is served with `frame-ancestors 'self' chrome-extension:`.

## WhatsApp Desktop (macOS)

`src/connectors/whatsapp-mac/`.

WhatsApp for Mac is a Mac Catalyst app (bundle `net.whatsapp.WhatsApp`; the Electron app
was retired in 2024). It keeps an iPhone-style Core Data store, unencrypted, in
`~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/`:

- `ChatStorage.sqlite` (WAL mode): `ZWACHATSESSION`, `ZWAMESSAGE`, `ZWAGROUPMEMBER`,
  `ZWAMEDIAITEM`, `ZWAPROFILEPUSHNAME`, `ZWAMESSAGEINFO`
- `ContactsV2.sqlite`: `ZWAADDRESSBOOKCONTACT`, saved names, including by LID
- `LID.sqlite`: `ZWAZACCOUNT`, mapping opaque `@lid` ids to phone numbers

How the reader works:

- **Opening.** A read-only connection with `query_only` and a 5 s busy timeout. Each read
  is one short transaction, so WhatsApp's checkpoints are never held up. `immutable` is
  never used: the newest rows live in the WAL.
- **Change detection.** `PRAGMA data_version` is polled every 1.5 s. On a change it reads
  rows above the last `Z_PK`, then re-reads the newest 300 rows to catch edits and
  deletes, which rewrite rows in place. A text change marks an edit; type 14 marks
  deleted for everyone.
- **Schema guard.** It builds every query from the columns that exist. If a required
  column is missing it refuses with the column's name rather than misreading.
- **Identity.** Group senders are mostly `@lid`. The reader folds LIDs into phone-number
  JIDs via LID.sqlite and contacts, so one person is one person. Message ids are
  (direction, stanza id). History-sync duplicates (`ZSORT < 0`) never replace the
  primary row.
- **Names.** Saved contact, then chat name, then group member record, then push name.
- **Extras.** Unread counts mirror the app (`-1` means marked unread). Reactions are
  decoded from the `ZRECEIPTINFO` protobuf, and replies from `ZPARENTMESSAGE`. Media is
  linked only when the file is really on disk; most of it isn't, and iCloud-style
  placeholder stubs, which block on read, are skipped.
- **Permissions.** macOS 15+ protects app group containers. The first read triggers "would
  like to access data from other apps", and an Allow lasts only for that process. Full
  Disk Access on the launching app (Terminal, …) is the lasting fix.

Sources: six-plus open-source readers of this exact store updated in Sept–Oct 2026
(openclaw/wacrawl, ezzabuzaid/elt, arraypress/swift-whatsapp-messages, kenn-io/msgvault,
stacksjs/stacks, raycast/extensions), Mysk's 2024 and 2026 disclosures, Apple's macOS 15
release notes, and SQLite's WAL/URI docs. The independent fact-check pass for this area
didn't run (session limit), so treat type codes past 15 and edit detection as
best-effort.

## Instagram in Chrome

`extension/` (MV3), `src/connectors/browser/`.

As of October 2026, Instagram web no longer uses Messenger's protocol: it moved DMs to a
new GraphQL-plus-binary-WebSocket stack in June 2026. It also dropped end-to-end
encryption for DMs in May 2026. The wire formats are undocumented and change often, so
the extension reads the **DOM**:

- **Thread id:** `/direct/t/<thread_fbid>/`.
- **Messages:** `div[role="article"]` inside `div[role="group"]` rows, or
  `[role="presentation"]` bubbles on accounts with the other layout. Text comes from
  `dir="auto"` leaves. Class names are never used.
- **Your messages:** they hug the right edge of their row. That's geometry, so it assumes
  a left-to-right UI language.
- **Times:** only from the centred divider rows ("Today 10:42", "3 Oct 2026"), in English.
- **The list:** it's a `column-reverse` scroller that renders about 20 bubbles at a time.

The content script is passive by default: no requests, no clicks, no DOM edits. It sends
a snapshot of the visible window to the service worker whenever the page settles. The
worker posts it to the local server. Extension pages are exempt from Chrome's Local
Network Access prompts; content scripts are not, which is why the page never calls
`localhost` itself.

**Stitching windows together** (`align.ts`). The page has no message ids, and each
capture is a ~20-message slice. Each capture is aligned against the stored messages
around it with a longest common subsequence over a signature (direction, text,
attachment types). Matches keep their ids. New messages get ids anchored to the stored
message before them, and times from the page's dividers, clamped between stored
neighbours, or interpolated. Repeated short messages ("ok", "ok") stay distinct, and a
bubble that scrolls out and back in isn't duplicated. The signature leaves out sender
names because names are inferred from avatars that come and go.

**Read earlier messages** is the one exception to passive reading, and only when you
click it. It scrolls the thread back by ¾ of a screen, waits 1.5 s plus Instagram's
loading skeleton, and stops at 40 steps or when nothing moves three times in a row.

**Side panel.** A thin frame around the local app's companion view (`/?view=companion
&embed=extension`), told by the extension which thread the active tab has open. It
offers "Read earlier messages" and "Check reader" (a diagnostic snapshot of what the
reader sees, for when Instagram changes its markup).

## Views

- **Inbox** (`/`): every conversation, with the thread, insights and imports.
- **Companion** (`/?view=companion`): a narrow view for beside an app.
  - **Follow** switches to the chat you just sent a message in.
  - **Float** opens it in Chrome's Document Picture-in-Picture, so it stays above every
    app with nothing to install.
  - Inside the extension's side panel, focus comes from the extension instead.

## Insights

`src/insights/`.

Deterministic stats: message share, words, who starts conversations (after 6 h of
silence), median reply time, and activity by hour, weekday and month. Reply gaps under
a second are ignored, because they come from coarse clocks (minute-precision exports,
Instagram's occasional dividers) rather than real replies. A transcript formatter
produces the same plain text you'd paste into a model.

## Next

1. **Follow the chat that's open in WhatsApp, not just the one you last sent in.**
   WhatsApp for Mac exposes the open chat's name through Accessibility
   (`AXIdentifier == "NavigationBar_HeaderViewButton"`). A small helper with
   Accessibility permission can poll it. This needs a Mac to build and test.
2. **The LLM layer.** "Ask about this conversation" in the insights panel. "Explain or
   translate this message" with its surrounding context. Catch-up summaries. Context is
   the stats plus a transcript window, with retrieval for long histories. Decide hosted
   (best quality; chats leave the machine) vs local, and keep it opt-in per conversation.
3. **Drafts.** Insert a suggested reply into Instagram's composer (a Lexical editor;
   `execCommand('insertText')` is the reported working path), or copy it for WhatsApp.
   Never send, and never synthesize Enter.
4. **More surfaces.** The same extension can read web.whatsapp.com. On Windows, WhatsApp
   Desktop is now WhatsApp Web inside WebView2, which extensions can't reach.

## Known limitations

- The WhatsApp Desktop store is a linked-device cache: partial history, mostly
  undownloaded media.
- Instagram reading depends on markup that changes. "Check reader" shows when it breaks.
- Instagram times are approximate between dividers, and view-once messages aren't visible
  on the web.
- Imported conversations don't merge with live ones for the same person yet.
- There is no authentication, so keep the `127.0.0.1` binding.
