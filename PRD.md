# BlackCEO Command Center - Product Requirements Document
## Version 1.0.0
## April 12, 2026

---

## Overview

The BlackCEO Command Center is a Next.js dashboard application that provides a centralized interface for managing AI workforces across departments. It displays CEO Boards, Department Boards, Kanban task management, Performance tracking, Devil's Advocate oversight, and Intelligence Settings.

---

## Core Components

### 1. CEO Board

**Purpose:** High-level executive dashboard showing company-wide AI workforce status.

**Features:**
- Company health letter grade (A-F) calculated from weighted metrics:
  - 40% KPI Achievement
  - 30% Agent Performance
  - 15% Devil's Advocate Compliance
  - 15% Recommendation Follow-Through
- Real-time agent activity counter
- Department overview cards with:
  - Department emoji and name
  - Headcount (permanent vs on-call agents)
  - Active task count
  - Department health indicator
- Quick-action buttons for each department

**Data Sources:**
- `config/departments.json` - Department list and metadata
- `company-config.json` - KPI targets and benchmarks
- Database tables: kpi_snapshots, agent_activity, da_challenges, recommendations

---

### 2. Department Boards

**Purpose:** Sub-boards for each department showing detailed operations.

**Features:**
- Department-specific KPI tracking
- Specialist agent roster with:
  - Agent name and role
  - Assigned persona
  - Current task status
  - Performance metrics
- Department-specific Devil's Advocate challenges
- SOP quick-access links

**Data Sources:**
- `config/departments.json`
- `department-config.json` (per department)
- Database: department-specific task queries

---

### 3. Kanban Boards

**Purpose:** Visual task management with two view modes.

**View A: Department Browser**
- Left sidebar: Vertical list of all departments
  - Emoji + department name
  - Task count badges
  - Click to select active department
- Right panel: Kanban for selected department
  - Columns: New, Queued, In Progress, Review, Done
  - Cards show: task title, assigned agent, persona pill, priority badge

**View B: Focused Single-Department**
- Full-screen Kanban for one department
- No sidebar, maximum task visibility
- Large "Back" button returns to Department Browser
- Accessible via `/ceo-board/[dept]/focus`

**Columns:**
1. **New** - Tasks just created, not yet prioritized
2. **Queued** - Prioritized and waiting for agent assignment
3. **In Progress** - Currently being worked by an agent
4. **Review** - Completed, awaiting approval
5. **Done** - Approved and archived

**Data Sources:**
- Database: tasks table with department_id filtering
- Real-time updates via SSE (Server-Sent Events)

---

### 4. Performance Board

**Purpose:** Multi-lens analytics for business operations, agent performance, and proactive intelligence.

**Three Lenses:**

**Lens 1: Business Operations KPIs**
- Company-level and department-level KPIs
- Target vs actual progress bars
- Industry benchmark comparisons
- Historical trend charts

**Lens 2: Agent Performance**
- Task completion rates by agent
- Average task duration
- Quality scores from reviews
- Agent utilization heatmap

**Lens 3: Proactive Intelligence**
- Recommendations generated and followed
- Proactive task completion rate
- Insight-to-action conversion
- Intelligence ROI metrics

**Data Sources:**
- `company-config.json` - KPI definitions and targets
- Database: kpi_history, agent_activity, recommendations tables

---

### 5. Devil's Advocate

**Purpose:** Quality assurance system that challenges proposals before execution.

**Features:**
- Challenge feed showing recent DA reviews
- Review status indicators (pending, approved, rejected, escalated)
- Challenge detail view with:
  - Original proposal
  - DA feedback
  - Identified risks and alternatives
  - Recommended modifications
- Escalation tracking for unresolved challenges

**Review Types:**
1. **Required** - All proposals for high-risk operations
2. **Optional** - Agent can request review
3. **Standing** - Automatic review for specific task types
4. **Deep Dive** - Comprehensive analysis for major decisions

**Data Sources:**
- Database: da_challenges table
- `department-config.json` - DA settings per department

---

### 6. Intelligence Settings

**Purpose:** Configuration panel for persona selection and AI behavior.

**Features:**
- **Persona Categories:** Display all available personas from `persona-categories.json`
  - Category filters by domain (Marketing, Sales, Operations, etc.)
  - Persona details: name, description, domain tags, typical use cases
  - Runtime loading from disk (NOT hardcoded)
- **5-Layer Alignment Display:**
  - Company Mission match score
  - Owner Values alignment
  - Company Goals relevance
  - Department Goals fit
  - Task-specific suitability
- **Persona Selection Log:**
  - History of persona assignments
  - Selection reasoning per layer
  - Filter by department, date, task type

**Data Sources:**
- `~/[workspace]/coaching-personas/persona-categories.json`
- `persona-matrix.md` - Pre-qualified persona pools per department
- Database: persona_selection_log (new table)

---

## Technical Architecture

### Frontend
- **Framework:** Next.js 14+ with App Router
- **Styling:** Tailwind CSS
- **State:** React hooks + Server Components where possible
- **Real-time:** SSE (Server-Sent Events) for live updates

### Backend
- **API Routes:** Next.js API routes
- **Database:** SQLite (default) or PostgreSQL
- **Schema Tables:**
  - tasks
  - task_activities
  - task_deliverables
  - kpi_snapshots
  - agent_activity
  - recommendations
  - da_challenges
  - sub_agent_sessions

### Runtime Persona Resolution
```
1. Read persona-categories.json from workspace at runtime
2. Build dynamic PersonaOption[] array
3. Command Center displays live persona list
4. No hardcoded PERSONA_DETAILS map in TypeScript
```

### Port Configuration
- **Default:** 4000
- **Override:** PORT environment variable
- **All documentation:** References port 4000 consistently

---

## File Paths

### Command Center Reads From:
| File | Path | Purpose |
|------|------|---------|
| departments.json | `config/departments.json` | Department list |
| company-config.json | `config/company-config.json` | Company settings & KPIs |
| department-config.json | `config/[dept]/department-config.json` | Per-dept config |
| persona-categories.json | `[workspace]/coaching-personas/persona-categories.json` | Persona definitions |

### Generated by Skill 23 (AI Workforce Blueprint):
- `config/departments.json`
- `config/company-config.json`
- `config/[dept]/department-config.json`
- `departments/[dept]/workforce-interview-answers.md`
- `departments/[dept]/interview-handoff.md`

---

## Integration Points

### Skill 22 (Book-to-Persona)
- Creates persona blueprints
- Generates `persona-categories.json`
- Updates pre-qualified persona pools

### Skill 23 (AI Workforce Blueprint)
- Creates departments and roles
- Writes SOPs for each role
- Assigns personas using 5-layer alignment
- Generates all config files

### Skill 32 (Command Center Setup)
- Installs Command Center
- Configures PM2 on port 4000
- Sets up Cloudflare tunnel via n8n webhook

### n8n Workflow: i0P3OWCEsXZxVo0N
- Returns tunnel token in HTTP response
- Format: `{"status":"success","subdomain":"[name].zerohumanworkforce.com","tunnelToken":"[token]"}`

---

## User Flows

### First-Time Setup
1. Skill 23 interviews client about business
2. Departments and roles are created
3. SOPs written for each role
4. Personas assigned via 5-layer alignment
5. Config files generated
6. Skill 32 installs Command Center
7. Cloudflare tunnel established
8. Client accesses dashboard at their subdomain

### Daily Usage
1. CEO views CEO Board for company health
2. Clicks into department for details
3. Uses Kanban to track task progress
4. Reviews Performance Board for insights
5. Checks Devil's Advocate for pending challenges
6. Adjusts Intelligence Settings as needed

---

## Success Metrics

| Metric | Target |
|--------|--------|
| CEO Board load time | < 2 seconds |
| Kanban real-time sync | < 500ms latency |
| Persona categories load | < 1 second |
| Grade calculation accuracy | 100% match to formula |
| Uptime | 99.5% |

---

## Future Enhancements (Backlog)

- [ ] Mobile-responsive Kanban views
- [ ] Dark mode toggle
- [ ] Custom KPI builder
- [ ] Agent performance predictions
- [ ] Integration with external BI tools
- [ ] Voice command interface

---

*Document created based on BlackCEO System Overhaul Playbook v3.3*
*Last updated: April 12, 2026*
