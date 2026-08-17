# StarPilot Discord Bot

Discord bot for the StarPilot community: identity onboarding, structured bug/feedback reports, and wiki search via RAG.

## Features

- **Identity Onboarding** - button sets server nickname + vehicle
- **Structured Reports** - forum threads for bugs (with Route ID validation via comma.ai API), feedback, and feature requests
- **Wiki Search** - mention the bot to search the community wiki with semantic embedding

## Setup

Copy `.env.example` to `.env` and fill in the values:

```
DISCORD_TOKEN=...
GUILD_ID=...
IDENTIFICATION_CHANNEL_ID=...
FORUM_CHANNEL_ID=...
ROUTES_CHANNEL_ID=...
VERIFIED_ROLE=...
```

### Docker (recommended)

```bash
docker compose up -d
```

### Local development

```bash
npm install
npm run dev       # hot-reload via tsx
```

### Production

```bash
npm run build
npm start
```

## License

[MIT](LICENSE)
