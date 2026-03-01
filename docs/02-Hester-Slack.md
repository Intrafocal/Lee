# Hester Slack Integration Plan

> Extending Hester beyond local with Slack Bot for Ideas and Brief capabilities.

## Overview

This document outlines the plan to deploy Hester capabilities as a Slack bot using **Cloud Run + Slack Bolt Python**. The bot will enable:

1. **HesterIdeas** - Capture ideas via Slack DM (text, voice, images)
2. **HesterBrief** - Post daily development summaries to #daily-brief
3. **HesterQA Notifications** - Alert on test failures (future)

## Why Cloud Run + Slack Bolt?

| Aspect | Cloud Run | Supabase Edge Functions |
|--------|-----------|-------------------------|
| **Socket Mode** | Native support (Bolt maintains WebSocket) | Not possible (request/response only) |
| **Language** | Python (matches Hester codebase) | TypeScript/Deno only |
| **Code Reuse** | Full Hester codebase available | Would need rewrite |
| **Gemini SDK** | Python SDK (existing) | Different SDK |
| **Runtime** | Always-on with min instances | 60s limit per request |
| **Cost** | ~$5-15/mo (1 min instance) | Free tier likely covers |

**Socket Mode requires a persistent WebSocket connection** - Edge Functions can't do this since they're stateless request/response handlers. Cloud Run with min instances = 1 keeps the connection alive.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SLACK WORKSPACE                              │
│                   coefficiencynetwork.slack.com                      │
│                        (T09CAK2D6AH)                                 │
│                                                                      │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐         │
│   │  DM to Bot   │    │ #daily-brief │    │   #dev       │         │
│   │  (Ideas)     │    │  (Brief)     │    │  (Monitor)   │         │
│   └──────┬───────┘    └──────▲───────┘    └──────┬───────┘         │
│          │                   │                   │                  │
└──────────┼───────────────────┼───────────────────┼──────────────────┘
           │                   │                   │
           │    WebSocket      │                   │
           │    (Socket Mode)  │ Slack API         │ Slack API
           │                   │                   │
           ▼                   │                   ▼
┌──────────────────────────────┴───────────────────────────────────────┐
│                     CLOUD RUN: hester-slack                          │
│                     (min instances = 1)                              │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                   Slack Bolt (Python)                        │   │
│   │                                                              │   │
│   │  • Maintains WebSocket to Slack                              │   │
│   │  • Receives events (DMs, mentions, files)                    │   │
│   │  • Sends messages via Slack API                              │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│   ┌──────────────────────────┼───────────────────────────────────┐  │
│   │                    Hester Modules                             │  │
│   │                          │                                    │  │
│   │  ┌─────────────┐   ┌─────┴─────────┐   ┌─────────────┐       │  │
│   │  │ Ideas       │   │ Brief         │   │ QA Notify   │       │  │
│   │  │ Handler     │   │ Generator     │   │ (future)    │       │  │
│   │  └──────┬──────┘   └───────┬───────┘   └─────────────┘       │  │
│   │         │                  │                                  │  │
│   │         ▼                  ▼                                  │  │
│   │  ┌─────────────────────────────────────────────────────────┐ │  │
│   │  │              Shared Infrastructure                       │ │  │
│   │  │  • Gemini multimodal (existing)                         │ │  │
│   │  │  • Encryption service (existing)                        │ │  │
│   │  │  • Supabase client (existing)                           │ │  │
│   │  └─────────────────────────────────────────────────────────┘ │  │
│   └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    SUPABASE DATABASE (Production)                     │
│                                                                       │
│   ┌─────────────────────────────────────────────────────────────┐    │
│   │                      hester schema                           │    │
│   │                                                              │    │
│   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │    │
│   │  │ ideas        │  │ briefs       │  │ qa_results       │   │    │
│   │  │ (NEW)        │  │ (NEW)        │  │ (existing)       │   │    │
│   │  └──────────────┘  └──────────────┘  └──────────────────┘   │    │
│   │                                                              │    │
│   │  ┌──────────────────────────────────────────────────────┐   │    │
│   │  │ doc_embeddings (existing)                             │   │    │
│   │  └──────────────────────────────────────────────────────┘   │    │
│   └─────────────────────────────────────────────────────────────┘    │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
           │
           ▼
┌───────────────────────────────────────────────────────────────────────┐
│                      EXTERNAL SERVICES                                 │
│                                                                        │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │
│   │ Gemini API   │  │ GitHub API   │  │ Linear API   │               │
│   │ (multimodal) │  │ (PRs/commits)│  │ (issues)     │               │
│   └──────────────┘  └──────────────┘  └──────────────┘               │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Slack App Configuration

### App Setup

1. **Create Slack App** at https://api.slack.com/apps
   - App Name: `Hester`
   - Workspace: `coefficiencynetwork.slack.com`

2. **Enable Socket Mode**
   - Settings > Socket Mode > Enable
   - Generate App-Level Token with `connections:write` scope
   - Name: `hester-socket-token`

3. **Bot Token Scopes** (OAuth & Permissions)
   ```
   # Messaging
   chat:write              # Post messages
   chat:write.public       # Post to public channels
   im:history              # Read DM history
   im:read                 # View DM list
   im:write                # Start DMs

   # Files (for voice/image processing)
   files:read              # Access uploaded files

   # Users
   users:read              # Get user info
   users:read.email        # Get user emails (for mapping)

   # Channels (for Brief monitoring)
   channels:history        # Read channel messages
   channels:read           # View channel list
   ```

4. **Event Subscriptions**
   ```
   # Bot Events
   message.im              # DMs to bot (Ideas input)
   app_mention             # @Hester mentions
   file_shared             # Voice/image uploads
   ```

5. **Slash Commands** (optional)
   ```
   /hester-idea            # Quick idea capture
   /hester-brief           # Generate on-demand brief
   /hester-status          # Check Hester status
   ```

### Environment Variables

```bash
# Slack credentials (store in Supabase Vault)
SLACK_BOT_TOKEN=xoxb-...           # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...           # App-Level Token (Socket Mode)
SLACK_SIGNING_SECRET=...           # Request verification

# Slack configuration
SLACK_WORKSPACE_ID=T09CAK2D6AH
SLACK_BRIEF_CHANNEL=#daily-brief
SLACK_DEV_CHANNEL=#dev

# External APIs
GOOGLE_API_KEY=...                 # Gemini multimodal
GITHUB_TOKEN=...                   # GitHub API access
LINEAR_API_KEY=...                 # Linear API access

# Supabase (auto-injected in Edge Functions)
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

## Database Schema

### Migration: `20260103_add_hester_ideas_briefs.sql`

```sql
-- =============================================================================
-- Hester Ideas Table
-- Captures ideas from Slack DMs, CLI, or other sources
-- =============================================================================

CREATE TABLE IF NOT EXISTS hester.ideas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Source tracking
    source_type TEXT NOT NULL CHECK (source_type IN ('slack_dm', 'slack_command', 'cli', 'voice', 'image')),
    source_id TEXT,                          -- Slack message_ts, etc.
    source_channel TEXT,                     -- Slack channel/DM ID

    -- Content (encrypted at rest)
    encrypted_content TEXT NOT NULL,         -- Main idea text
    encrypted_raw_input TEXT,                -- Original input (voice transcript, etc.)
    encrypted_context TEXT,                  -- GraphRAG enrichment

    -- Metadata
    input_type TEXT NOT NULL CHECK (input_type IN ('text', 'voice', 'image', 'mixed')),
    tags TEXT[] DEFAULT '{}',
    related_entities JSONB DEFAULT '{}',     -- {files: [], concepts: [], people: []}

    -- Ownership
    created_by TEXT NOT NULL,                -- Slack user ID or team member identifier
    created_by_email TEXT,                   -- For cross-reference

    -- Status tracking
    status TEXT DEFAULT 'captured' CHECK (status IN ('captured', 'processing', 'enriched', 'archived', 'actioned')),
    actioned_as TEXT,                        -- 'linear_issue', 'doc_update', etc.
    actioned_ref TEXT,                       -- Linear issue ID, PR number, etc.

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    archived_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_hester_ideas_created_by ON hester.ideas(created_by);
CREATE INDEX idx_hester_ideas_created_at ON hester.ideas(created_at DESC);
CREATE INDEX idx_hester_ideas_status ON hester.ideas(status);
CREATE INDEX idx_hester_ideas_tags ON hester.ideas USING GIN(tags);

-- RLS: Service role only (internal tool)
ALTER TABLE hester.ideas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to ideas"
    ON hester.ideas
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- =============================================================================
-- Hester Briefs Table
-- Daily development summaries
-- =============================================================================

CREATE TABLE IF NOT EXISTS hester.briefs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Brief identification
    brief_date DATE NOT NULL,
    brief_type TEXT DEFAULT 'daily' CHECK (brief_type IN ('daily', 'weekly', 'ad_hoc')),

    -- Content (encrypted at rest)
    encrypted_content TEXT NOT NULL,         -- Generated brief markdown
    encrypted_raw_sources TEXT,              -- Raw source data before synthesis

    -- Source tracking
    sources JSONB DEFAULT '{}'::jsonb,       -- {github: {prs: [], commits: []}, linear: [], slack: []}
    source_date_range JSONB,                 -- {start: timestamp, end: timestamp}

    -- Slack posting
    posted_to_slack BOOLEAN DEFAULT false,
    slack_channel TEXT,
    slack_message_ts TEXT,
    slack_thread_ts TEXT,

    -- Metadata
    generated_by TEXT DEFAULT 'scheduled',   -- 'scheduled', 'manual', 'cli'
    generation_duration_ms INTEGER,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT now(),
    posted_at TIMESTAMPTZ,

    -- Ensure one brief per date per type
    UNIQUE(brief_date, brief_type)
);

-- Indexes
CREATE INDEX idx_hester_briefs_date ON hester.briefs(brief_date DESC);
CREATE INDEX idx_hester_briefs_posted ON hester.briefs(posted_to_slack);

-- RLS: Service role only
ALTER TABLE hester.briefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to briefs"
    ON hester.briefs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- =============================================================================
-- Hester Slack Users Mapping
-- Maps Slack users to internal identifiers
-- =============================================================================

CREATE TABLE IF NOT EXISTS hester.slack_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slack_user_id TEXT UNIQUE NOT NULL,      -- Slack's user ID (U...)
    slack_workspace_id TEXT NOT NULL,        -- T09CAK2D6AH
    slack_username TEXT,
    slack_display_name TEXT,
    slack_email TEXT,

    -- Internal mapping (optional)
    team_member_name TEXT,                   -- 'ben', 'alex', etc.
    profile_id UUID REFERENCES public.profiles(id),

    -- Preferences
    preferences JSONB DEFAULT '{}'::jsonb,   -- {brief_dm: true, idea_confirm: true}

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    last_interaction_at TIMESTAMPTZ
);

CREATE INDEX idx_hester_slack_users_slack_id ON hester.slack_users(slack_user_id);

-- RLS
ALTER TABLE hester.slack_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to slack_users"
    ON hester.slack_users
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- =============================================================================
-- Update timestamp trigger
-- =============================================================================

CREATE OR REPLACE FUNCTION hester.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ideas_updated_at
    BEFORE UPDATE ON hester.ideas
    FOR EACH ROW EXECUTE FUNCTION hester.update_updated_at();

CREATE TRIGGER slack_users_updated_at
    BEFORE UPDATE ON hester.slack_users
    FOR EACH ROW EXECUTE FUNCTION hester.update_updated_at();
```

## Code Structure

The Slack integration lives within the existing Hester codebase:

```
lee/hester/
├── slack/                           # NEW: Slack Bolt integration
│   ├── __init__.py
│   ├── app.py                       # Slack Bolt app (Socket Mode)
│   ├── handlers/
│   │   ├── __init__.py
│   │   ├── ideas.py                 # DM message handler
│   │   ├── brief.py                 # Brief commands/scheduling
│   │   ├── commands.py              # Slash commands
│   │   └── interactions.py          # Button clicks, modals
│   ├── formatters.py                # Block Kit message formatting
│   └── settings.py                  # Slack-specific config
│
├── ideas/                           # NEW: HesterIdeas implementation
│   ├── __init__.py
│   ├── agent.py                     # Idea processing agent
│   ├── models.py                    # Pydantic models
│   └── prompts.py                   # Gemini prompts
│
├── brief/                           # NEW: HesterBrief implementation
│   ├── __init__.py
│   ├── agent.py                     # Brief generation agent
│   ├── models.py                    # Pydantic models
│   ├── prompts.py                   # Gemini prompts
│   └── sources/
│       ├── __init__.py
│       ├── github.py                # GitHub API client
│       ├── linear.py                # Linear API client
│       └── slack.py                 # Slack history fetcher
│
├── shared/                          # Existing shared utilities
│   ├── gemini_tools.py              # Gemini multimodal (reuse)
│   └── surfaces.py                  # Output formatting (extend)
│
└── cli.py                           # Add slack subcommands
```

## Slack Bolt App

### Main App (slack/app.py)

```python
"""
Hester Slack Bot - Socket Mode Application.

Runs as a long-lived process maintaining WebSocket to Slack.
Deploy to Cloud Run with min instances = 1.
"""

import logging
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

from .settings import SlackSettings
from .handlers import ideas, brief, commands, interactions

logger = logging.getLogger("hester.slack")


def create_app() -> App:
    """Create and configure the Slack Bolt app."""
    settings = SlackSettings()

    app = App(token=settings.bot_token)

    # Register event handlers
    # ---------------------------------------------------------------------

    # DM messages -> Ideas capture
    @app.event("message")
    async def handle_message(event, say, client):
        # Only handle DMs (im channel type)
        if event.get("channel_type") == "im":
            await ideas.handle_dm(event, say, client, settings)

    # File uploads in DMs -> Voice/image processing
    @app.event("file_shared")
    async def handle_file(event, client):
        await ideas.handle_file_shared(event, client, settings)

    # @Hester mentions
    @app.event("app_mention")
    async def handle_mention(event, say):
        await say("I'm here. DM me with ideas, or use `/hester` commands.")

    # Register slash commands
    # ---------------------------------------------------------------------

    @app.command("/hester-idea")
    async def handle_idea_command(ack, command, client):
        await ack()
        await commands.handle_idea(command, client, settings)

    @app.command("/hester-brief")
    async def handle_brief_command(ack, command, respond):
        await ack()
        await commands.handle_brief(command, respond, settings)

    @app.command("/hester-status")
    async def handle_status_command(ack, respond):
        await ack()
        await commands.handle_status(respond)

    # Register interactive handlers
    # ---------------------------------------------------------------------

    @app.action("idea_to_linear")
    async def handle_idea_to_linear(ack, body, client):
        await ack()
        await interactions.create_linear_issue(body, client, settings)

    @app.action("idea_archive")
    async def handle_idea_archive(ack, body, client):
        await ack()
        await interactions.archive_idea(body, client)

    return app


def run():
    """Run the Slack bot in Socket Mode."""
    settings = SlackSettings()

    app = create_app()
    handler = SocketModeHandler(app, settings.app_token)

    logger.info("Starting Hester Slack bot (Socket Mode)...")
    handler.start()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run()
```

### Ideas Handler (slack/handlers/ideas.py)

```python
"""
Handle DM messages for idea capture.
"""

import logging
from typing import Optional

from slack_sdk.web.async_client import AsyncWebClient

from ...ideas.agent import IdeasAgent
from ...ideas.models import IdeaInput, IdeaSource
from ..formatters import format_idea_confirmation
from ..settings import SlackSettings

logger = logging.getLogger("hester.slack.ideas")


async def handle_dm(
    event: dict,
    say,
    client: AsyncWebClient,
    settings: SlackSettings,
) -> None:
    """
    Handle a DM message - capture as idea.

    Args:
        event: Slack message event
        say: Slack say function
        client: Slack web client
        settings: Slack settings
    """
    # Ignore bot messages
    if event.get("bot_id"):
        return

    user_id = event.get("user")
    text = event.get("text", "")
    channel = event.get("channel")
    message_ts = event.get("ts")

    logger.info(f"Received DM from {user_id}: {text[:50]}...")

    # Check for attached files
    files = event.get("files", [])
    voice_file = next((f for f in files if f.get("mimetype", "").startswith("audio/")), None)
    image_files = [f for f in files if f.get("mimetype", "").startswith("image/")]

    # Build idea input
    idea_input = IdeaInput(
        source=IdeaSource.SLACK_DM,
        source_id=message_ts,
        source_channel=channel,
        created_by=user_id,
        text=text if text else None,
        voice_url=voice_file.get("url_private") if voice_file else None,
        image_urls=[f.get("url_private") for f in image_files] if image_files else None,
    )

    # Process the idea
    agent = IdeasAgent(settings=settings)
    result = await agent.process(idea_input)

    # Send confirmation
    blocks = format_idea_confirmation(result)
    await say(blocks=blocks, text=f"Got it: {result.summary[:100]}...")


async def handle_file_shared(
    event: dict,
    client: AsyncWebClient,
    settings: SlackSettings,
) -> None:
    """
    Handle file shared event for voice/image processing.

    This fires when a file is uploaded. We check if it's in a DM
    and process accordingly.
    """
    file_id = event.get("file_id")
    channel_id = event.get("channel_id")

    # Get file info
    file_info = await client.files_info(file=file_id)
    file_data = file_info.get("file", {})

    # Check if this is a DM
    channel_info = await client.conversations_info(channel=channel_id)
    if not channel_info.get("channel", {}).get("is_im"):
        return  # Not a DM, ignore

    logger.info(f"File shared in DM: {file_data.get('name')}")

    # The message handler will pick this up via event["files"]
    # This handler is mainly for standalone file shares without text
```

### Brief Generator (brief/agent.py)

```python
"""
HesterBrief Agent - Generate daily development summaries.
"""

import logging
from datetime import date, datetime, timedelta
from typing import Optional

from shared.encryption.service import EncryptionService
from shared.database.client import get_supabase_client

from .models import Brief, BriefSources, DateRange
from .prompts import BRIEF_SYNTHESIS_PROMPT
from .sources.github import GitHubSource
from .sources.linear import LinearSource
from .sources.slack import SlackSource
from ..shared.gemini_tools import GeminiToolCapability

logger = logging.getLogger("hester.brief")


class BriefAgent(GeminiToolCapability):
    """
    Agent for generating daily development briefs.

    Pulls from GitHub, Linear, and Slack, then synthesizes
    a summary using Gemini.
    """

    def __init__(self, settings=None):
        self.settings = settings
        self.db = get_supabase_client()
        self.encryption = EncryptionService()

        # Initialize sources
        self.github = GitHubSource(settings)
        self.linear = LinearSource(settings)
        self.slack = SlackSource(settings)

    async def generate(
        self,
        brief_date: Optional[date] = None,
        lookback_hours: int = 24,
    ) -> Brief:
        """
        Generate a daily brief.

        Args:
            brief_date: Date for the brief (defaults to today)
            lookback_hours: How far back to look for activity

        Returns:
            Generated Brief
        """
        brief_date = brief_date or date.today()
        end_time = datetime.now()
        start_time = end_time - timedelta(hours=lookback_hours)

        date_range = DateRange(start=start_time, end=end_time)

        logger.info(f"Generating brief for {brief_date}, range: {date_range}")

        # 1. Fetch from all sources concurrently
        github_data = await self.github.fetch(date_range)
        linear_data = await self.linear.fetch(date_range)
        slack_data = await self.slack.fetch(date_range)

        sources = BriefSources(
            github=github_data,
            linear=linear_data,
            slack=slack_data,
        )

        # 2. Synthesize with Gemini
        prompt = BRIEF_SYNTHESIS_PROMPT.format(
            date=brief_date,
            github_summary=github_data.summary(),
            linear_summary=linear_data.summary(),
            slack_summary=slack_data.summary(),
        )

        response = await self.generate_with_gemini(prompt)

        # 3. Parse into structured brief
        brief = Brief(
            brief_date=brief_date,
            big_picture=response.get("big_picture", ""),
            shipped=response.get("shipped", []),
            in_progress=response.get("in_progress", []),
            decisions_made=response.get("decisions", []),
            questions_for_business=response.get("questions", []),
            sources=sources,
        )

        # 4. Store encrypted
        await self._store(brief)

        return brief

    async def _store(self, brief: Brief) -> None:
        """Encrypt and store brief to database."""
        encrypted_content = self.encryption.encrypt_field(brief.to_markdown())
        encrypted_sources = self.encryption.encrypt_field(brief.sources.to_json())

        await self.db.table("hester.briefs").upsert({
            "brief_date": str(brief.brief_date),
            "brief_type": "daily",
            "encrypted_content": encrypted_content,
            "encrypted_raw_sources": encrypted_sources,
            "sources": brief.sources.summary_json(),
        }).execute()

        logger.info(f"Stored brief for {brief.brief_date}")
```

## Slack Message Formats

### Idea Confirmation

```json
{
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Idea captured*"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "\"Genome scoring should factor in recency of experiences...\""
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "Tags: `genome` `scoring` `algorithm`"
        }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Create Linear Issue" },
          "action_id": "idea_to_linear"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Archive" },
          "action_id": "idea_archive"
        }
      ]
    }
  ]
}
```

### Daily Brief

```json
{
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "Daily Brief - January 3, 2026"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Big Picture*\nFocus on onboarding polish and Hester Slack integration."
      }
    },
    {
      "type": "divider"
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Shipped*\n• Onboarding scene audio sync\n• Evidence pipeline encryption\n• PWA icon improvements"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*In Progress*\n• Hester Slack bot integration\n• Genome card refinements"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Questions for Business*\n• Should brief include weekend activity?"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "Sources: 5 PRs, 3 Linear issues, 12 #dev messages"
        }
      ]
    }
  ]
}
```

## Cloud Run Deployment

### Dockerfile

```dockerfile
# lee/hester/Dockerfile.slack
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY lee/hester/requirements-slack.txt .
RUN pip install --no-cache-dir -r requirements-slack.txt

# Copy hester package
COPY lee/hester/ ./hester/
COPY shared/ ./shared/

# Set environment
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# Run the Slack bot
CMD ["python", "-m", "hester.slack.app"]
```

### requirements-slack.txt

```
slack-bolt>=1.18.0
slack-sdk>=3.21.0
google-generativeai>=0.3.0
supabase>=2.0.0
pydantic>=2.0.0
httpx>=0.24.0
cryptography>=41.0.0
```

### Cloud Run Configuration

```yaml
# infrastructure/k8s/hester-slack/cloudrun.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: hester-slack
  labels:
    cloud.googleapis.com/location: us-central1
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1"  # Always on for WebSocket
        autoscaling.knative.dev/maxScale: "1"  # Single instance
        run.googleapis.com/cpu-throttling: "false"  # No throttling
    spec:
      containerConcurrency: 1000
      timeoutSeconds: 3600
      containers:
        - image: gcr.io/PROJECT_ID/hester-slack:latest
          ports:
            - containerPort: 8080
          resources:
            limits:
              cpu: "1"
              memory: 512Mi
          env:
            - name: SLACK_BOT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: hester-slack-secrets
                  key: bot-token
            - name: SLACK_APP_TOKEN
              valueFrom:
                secretKeyRef:
                  name: hester-slack-secrets
                  key: app-token
            - name: GOOGLE_API_KEY
              valueFrom:
                secretKeyRef:
                  name: hester-slack-secrets
                  key: google-api-key
            - name: SUPABASE_URL
              valueFrom:
                secretKeyRef:
                  name: hester-slack-secrets
                  key: supabase-url
            - name: SUPABASE_SERVICE_KEY
              valueFrom:
                secretKeyRef:
                  name: hester-slack-secrets
                  key: supabase-service-key
```

### Deploy Commands

```bash
# Build and push image
docker build -f lee/hester/Dockerfile.slack -t gcr.io/$PROJECT_ID/hester-slack:latest .
docker push gcr.io/$PROJECT_ID/hester-slack:latest

# Create secrets
gcloud secrets create hester-slack-bot-token --data-file=- <<< "$SLACK_BOT_TOKEN"
gcloud secrets create hester-slack-app-token --data-file=- <<< "$SLACK_APP_TOKEN"

# Deploy to Cloud Run
gcloud run deploy hester-slack \
  --image gcr.io/$PROJECT_ID/hester-slack:latest \
  --region us-central1 \
  --min-instances 1 \
  --max-instances 1 \
  --cpu 1 \
  --memory 512Mi \
  --no-cpu-throttling \
  --set-secrets "SLACK_BOT_TOKEN=hester-slack-bot-token:latest,SLACK_APP_TOKEN=hester-slack-app-token:latest"
```

## Scheduling

### Brief Generation Schedule

The brief generation runs on a schedule. Options:

**Option 1: Cloud Scheduler (recommended)**

```bash
# Create scheduler job to trigger brief generation
gcloud scheduler jobs create http hester-daily-brief \
  --schedule="0 7 * * 1-5" \
  --uri="https://hester-slack-xxx.run.app/trigger-brief" \
  --http-method=POST \
  --headers="Authorization=Bearer \$(gcloud auth print-identity-token)" \
  --time-zone="America/Los_Angeles" \
  --description="Generate daily brief at 7 AM PT, Mon-Fri"
```

**Option 2: In-process scheduler (APScheduler)**

```python
# In slack/app.py - add scheduled brief generation
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

scheduler = AsyncIOScheduler()

@scheduler.scheduled_job(CronTrigger(hour=7, minute=0, day_of_week='mon-fri'))
async def scheduled_brief():
    """Generate and post daily brief at 7 AM, Mon-Fri."""
    from ..brief.agent import BriefAgent
    from .handlers.brief import post_brief_to_slack

    agent = BriefAgent()
    brief = await agent.generate()
    await post_brief_to_slack(brief)

# Start scheduler with app
scheduler.start()
```

**Option 3: GitHub Actions**

```yaml
# .github/workflows/hester-brief.yml
name: Hester Daily Brief
on:
  schedule:
    - cron: '0 14 * * 1-5'  # 7 AM PT = 14:00 UTC
  workflow_dispatch:

jobs:
  generate-brief:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Brief
        run: |
          curl -X POST \
            -H "Authorization: Bearer ${{ secrets.HESTER_TRIGGER_TOKEN }}" \
            https://hester-slack-xxx.run.app/trigger-brief
```

## Implementation Phases

### Phase 1: Foundation (Week 1)

1. **Database Setup**
   - [ ] Create migration for `hester.ideas`, `hester.briefs`, `hester.slack_users`
   - [ ] Apply to local Supabase
   - [ ] Push to production Supabase

2. **Slack App Setup**
   - [ ] Create Slack app at api.slack.com/apps
   - [ ] Enable Socket Mode, generate app token
   - [ ] Add bot scopes (chat:write, im:history, files:read, etc.)
   - [ ] Install to workspace, get bot token

3. **Code Scaffolding**
   - [ ] Create `lee/hester/slack/` module structure
   - [ ] Create `lee/hester/ideas/` module structure
   - [ ] Create `lee/hester/brief/` module structure
   - [ ] Add settings/config classes
   - [ ] Test Slack Bolt app locally

### Phase 2: Ideas Capture (Week 2)

1. **DM Handler**
   - [ ] Text message capture
   - [ ] Store to database (encrypted)
   - [ ] Confirmation message with Block Kit

2. **Multimodal Processing**
   - [ ] Voice file download from Slack
   - [ ] Gemini audio transcription
   - [ ] Image analysis with Gemini
   - [ ] Combined text+media handling

3. **Enrichment**
   - [ ] Tag extraction via Gemini
   - [ ] Entity recognition
   - [ ] Summary generation

### Phase 3: Daily Brief (Week 3)

1. **Source Integrations**
   - [ ] GitHub API client (PRs, commits from coefficiencynetwork org)
   - [ ] Linear API client (issues, updates)
   - [ ] Slack API client (channel history from #dev)

2. **Brief Generation**
   - [ ] Gemini synthesis prompt
   - [ ] Structured brief model
   - [ ] Encrypted storage

3. **Slack Posting**
   - [ ] Block Kit formatting for briefs
   - [ ] Post to #daily-brief
   - [ ] Thread for detailed sources

### Phase 4: Deployment & Polish (Week 4)

1. **Cloud Run Deployment**
   - [ ] Create Dockerfile
   - [ ] Set up GCP secrets
   - [ ] Deploy with min-instances=1
   - [ ] Set up Cloud Scheduler for briefs

2. **Interactive Features**
   - [ ] "Create Linear Issue" button for ideas
   - [ ] "Archive" button for ideas
   - [ ] Slash commands (/hester-idea, /hester-brief)

3. **CLI Integration**
   - [ ] `hester ideas list` reads from production
   - [ ] `hester brief show` fetches latest
   - [ ] `hester slack status` checks bot health

4. **QA Notifications (stretch)**
   - [ ] Post test failures to #dev
   - [ ] Include transcript/screenshot links

## Local Development

### Running Locally

```bash
# 1. Set environment variables
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export GOOGLE_API_KEY=...
export SUPABASE_URL=http://127.0.0.1:54321  # Local Supabase
export SUPABASE_SERVICE_KEY=...

# 2. Start local Supabase
npx supabase start

# 3. Run the Slack bot
cd lee
python -m hester.slack.app

# Or via CLI
hester slack start
```

### Testing Without Slack

```bash
# Test ideas processing directly
hester ideas capture "This is a test idea from CLI"

# Test brief generation
hester brief generate --since yesterday --no-post

# Test with mock Slack events
python -m hester.slack.test_handlers
```

## CLI Updates

Add Slack-related commands to `lee/hester/cli.py`:

```python
@cli.group()
def slack():
    """Slack bot commands."""
    pass


@slack.command("start")
@click.option("--debug", is_flag=True, help="Enable debug logging")
def start_slack(debug: bool):
    """Start the Slack bot locally."""
    import logging
    if debug:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO)

    from hester.slack.app import run
    run()


@slack.command("status")
def slack_status():
    """Check Slack bot connection status."""
    # Check if bot can connect to Slack API
    pass


# Update ideas group
@ideas.command("list")
@click.option("--limit", "-l", default=10)
@click.option("--status", "-s", type=click.Choice(["captured", "enriched", "archived"]))
def list_ideas(limit: int, status: str):
    """List captured ideas from database."""
    from hester.ideas.agent import IdeasAgent
    agent = IdeasAgent()
    ideas = agent.list(limit=limit, status=status)
    # Format and display
    for idea in ideas:
        console.print(f"[cyan]{idea.created_at}[/cyan] {idea.summary}")


@ideas.command("capture")
@click.argument("text")
def capture_idea(text: str):
    """Capture an idea from CLI."""
    from hester.ideas.agent import IdeasAgent
    from hester.ideas.models import IdeaInput, IdeaSource

    agent = IdeasAgent()
    result = asyncio.run(agent.process(IdeaInput(
        source=IdeaSource.CLI,
        text=text,
        created_by="cli",
    )))
    console.print(f"[green]Captured:[/green] {result.summary}")


# Update brief group
@brief.command("generate")
@click.option("--since", default="yesterday")
@click.option("--post/--no-post", default=False, help="Post to Slack after generation")
def generate_brief(since: str, post: bool):
    """Generate a daily brief."""
    from hester.brief.agent import BriefAgent

    agent = BriefAgent()
    brief = asyncio.run(agent.generate())

    console.print(format_brief(brief))

    if post:
        from hester.slack.handlers.brief import post_brief_to_slack
        asyncio.run(post_brief_to_slack(brief))
        console.print("[green]Posted to Slack[/green]")


@brief.command("show")
@click.option("--date", "-d", default="today")
def show_brief(date: str):
    """Show brief for a specific date."""
    from hester.brief.agent import BriefAgent

    agent = BriefAgent()
    brief = agent.get(date)

    if brief:
        console.print(format_brief(brief))
    else:
        console.print(f"[yellow]No brief found for {date}[/yellow]")
```

## Security Considerations

1. **Encryption at Rest**
   - All idea content encrypted before storage
   - All brief content encrypted before storage
   - Use existing `shared/encryption/service.py` patterns

2. **Slack Verification**
   - Verify request signatures on all endpoints
   - Validate workspace ID matches config

3. **Token Storage**
   - Store tokens in Supabase Vault
   - Never log tokens or sensitive content

4. **Access Control**
   - RLS policies restrict to service role
   - No public API access to Hester tables

## Monitoring

1. **Logging**
   - Log all Slack events (without content)
   - Log processing times
   - Log errors with context

2. **Metrics**
   - Ideas captured per day
   - Brief generation success rate
   - Processing latency

3. **Alerts**
   - Brief generation failure
   - Slack API errors
   - High error rate

## CLI Updates

Update `lee/hester/cli.py` to support production data:

```python
@ideas.command("list")
@click.option("--limit", "-l", default=10)
@click.option("--status", "-s", default=None)
def list_ideas(limit: int, status: str):
    """List captured ideas from production."""
    # Connect to production Supabase
    # Decrypt and display ideas
    pass

@brief.command("show")
@click.option("--date", "-d", default="today")
def show_brief(date: str):
    """Show brief for a specific date."""
    # Fetch from production
    # Decrypt and display
    pass

@brief.command("generate")
@click.option("--since", default="yesterday")
@click.option("--post/--no-post", default=False)
def generate_brief(since: str, post: bool):
    """Manually trigger brief generation."""
    # Call Edge Function
    pass
```

## Related Documentation

- `lee/hester/CLAUDE.md` - Full Hester reference
- `lee/docs/00-Hester-Initial.md` - Original specification
- `docs/Data Encryption.md` - Encryption patterns
