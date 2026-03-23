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
- **Departments:** Configure in `config/departments.json`
- **Port:** 4000 (default)
- **Logo:** Place at `public/logo.png` or set `NEXT_PUBLIC_LOGO_URL`

See deployment documentation for full setup instructions.
