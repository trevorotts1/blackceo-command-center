# Command Center

AI Agent Management Dashboard - A universal template for any organization.

## Overview

Command Center is a sophisticated web application for managing and orchestrating AI agents. It provides a visual dashboard for task management, agent coordination, and real-time monitoring of agent activities.

## Tech Stack

- **Frontend:** Next.js 15, React 19, TypeScript
- **Styling:** Tailwind CSS with custom design system
- **Database:** SQLite (better-sqlite3)
- **Real-time:** Server-Sent Events (SSE)
- **State:** Zustand

## Features

- **Agent Management:** Multi-agent coordination across departments
- **Task Board:** Kanban-style task management with drag-and-drop
- **Live Feed:** Real-time activity monitoring
- **Planning Phase:** Collaborative task specification with AI agents
- **Workspace Support:** Multi-workspace organization by department
- **Multi-Company:** Support for multiple companies/organizations
- **Intelligence Settings:** Per-department model and persona configuration with quick-access header panel
- **Dynamic Departments:** Departments loaded from database workspaces, not hardcoded lists
- **Brand Palette:** Automatic complementary color generation from company primary/secondary colors
- **CEO Performance Board:** Company health grading, department analytics, recommendations, benchmarks

## Setup

```bash
# Set your company name
export COMPANY_NAME="Your Company Name"

# Install dependencies
npm install

# Build and start
npm run build
pm2 start ecosystem.config.cjs
```

## Configuration

- **Company name:** Set via `COMPANY_NAME` env var or populated from database
- **Departments:** Loaded dynamically from database workspaces; configure via `config/departments.json` or Skill 23 seed
- **Port:** `${PORT:-3000}` (env var, defaults to 3000)
- **Logo:** Place at `public/logo.png` or set `NEXT_PUBLIC_LOGO_URL`
- **Brand colors:** Set primary/secondary hex colors on the company record; palette auto-generates
- **Intelligence:** Settings > Intelligence for per-department AI model and persona assignment

See deployment documentation for full setup instructions.
