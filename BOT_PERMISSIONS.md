# StarPilot Bot — Discord Permissions

This file lists the exact Discord bot permissions the StarPilot bot (zoombot) needs to run. Each entry was taken from a full audit of every Discord API call in `src/`. If a permission is not listed here, the code does not use it.

## Required OAuth2 scopes

In the Discord Developer Portal, open **OAuth2 → URL Generator** and select these scopes:

- **bot** — adds the bot to a guild.
- **applications.commands** — registers slash commands and context menus for users.

The bot registers slash commands (`src/handlers/share-route.ts:355`) and context menus for messages and users (`src/handlers/report/report-actions.ts:1453`, `src/handlers/report/index.ts:137`).

## Required General permissions

Tick these under **General Permissions**:

| Permission | Reason |
|---|---|
| View Channels | Reads the forum, identification, report-button, routes, and development channels. Example: `src/handlers/events.ts:208`, `:215`. |
| Manage Roles | Assigns the verified role and removes the pending role. `src/handlers/identification/index.ts:91`, `:102`. |
| Manage Nicknames | Sets a member's nickname during identification. `src/handlers/identification/index.ts:81`. |

## Required Text permissions

Tick these under **Text Permissions**:

| Permission | Reason |
|---|---|
| Send Messages | Posts messages and replies. `src/handlers/events.ts:152`, `:222`. |
| Send Messages in Threads | Posts inside forum threads. `src/handlers/report/report-actions.ts:229`. |
| Create Public Threads | Creates forum posts. `src/handlers/report/report-service.ts:139`. |
| Manage Messages | Deletes its own notice messages and pins or unpins starters. `src/handlers/report/report-actions.ts:274`, `:508`, `:1048`. |
| Manage Threads | Renames, archives, locks, un-archives, sets tags, and adds members to threads. `src/handlers/report/title-sync.ts:159`, `report-actions.ts:127`, `:128`, `route-tracker.ts:400`, `report-service.ts:69`, `report-actions.ts:80`. |
| Embed Links | Builds embeds in nearly every handler. `src/handlers/share-route.ts:124`. |
| Attach Files | Uploads rendered video clips. `src/handlers/clip/clip-service.ts:442`. |
| Read Message History | Fetches referenced messages, pinned messages, and thread starters. `src/handlers/events.ts:143`, `:215`, `report-actions.ts:257`, `:1440`. |
| Add Reactions | Reacts with the hourglass emoji during wiki search. `src/handlers/events.ts:172`. |

## Permission integer

Computed from the bits above with discord.js v14 `PermissionFlagsBits`:

```
328967777344
```

Use this value as a cross-check. Generate the authoritative value in the Developer Portal **OAuth2 → URL Generator** by ticking the boxes in the two tables above.

## Privileged Gateway Intents

These are not bot permissions. Switch them on in **Bot → Privileged Gateway Intents**. The bot requests them in `src/index.ts:16-19`:

- **Server Members Intent** (`GuildMembers`)
- **Message Content Intent** (`MessageContent`)

The bot will not start correctly without these two intents.

## Role hierarchy

Manage Roles and Manage Nicknames also need the bot's top role to sit above the verified and pending roles in the server's role list. Permission bits alone are not enough. The bot's own error messages say this directly (`src/handlers/identification/index.ts:84`, `:95`).

## Permissions NOT required

Leave these unchecked. The code does not use them:

- **General:** Administrator, View Audit Log, Manage Server, Manage Channels, Kick Members, Ban Members, Create Instant Invite, Change Nickname, Manage Expressions, Create Expressions, Manage Webhooks, Manage Events, Create Events, Moderate Members, View Server Insights, View Server Subscription Insights.
- **Text:** Create Private Threads, Send TTS Messages, Pin Messages (covered by Manage Messages), Mention Everyone, Use External Emojis, Use External Stickers, Use Embedded Activities, Use External Apps, Create Polls, Bypass Slowmode, Send Voice Messages.
- **Use Slash Commands:** optional. A bot account runs application commands without this guild permission. Ticking it does no harm.
