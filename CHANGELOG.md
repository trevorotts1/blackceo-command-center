# Changelog

## v2.9.3 - April 1, 2026

### Upgraded — n8n TOOLS.md to 10/10
- **agents/n8n-workflow-builder/TOOLS.md:** Complete rewrite with full API documentation
- Added authentication example with curl and header format
- Added 7 real API call examples: list, get, create, activate, deactivate, webhook execute, delete
- Added working Webhook-to-Telegram workflow JSON template with deploy command
- Added environment variables table (N8N_API_KEY, N8N_BASE_URL)
- Added 6 common BlackCEO automation use cases
- Added troubleshooting section covering 6 common errors and fixes

## v2.9.2 — April 1, 2026
- Fix HANDOFF.md port header to show Mac: 3000 | VPS: 4000 (QC fix)


## v2.9.1 - April 1, 2026

### Fixed — VPS Deployment Readiness
- **ecosystem.config.cjs:** Changed `/opt/homebrew/bin/npx` to `npx` (Mac-only path broke VPS/Docker)
- **HANDOFF.md:** Updated port 3000 references to 4000, removed hardcoded Mac IPs
- **UI_CHANGES_SUMMARY.md:** Fixed localhost:3000 to localhost:4000
- **config.ts:** Fixed `/Users/user` fallback path to `/root` for Linux/VPS compatibility

### Added — VPS Deployment Docs
- **DEPLOYMENT.md:** Added "Cloudflare Tunnel (Mac Only)" section with VPS skip instructions
- **DEPLOYMENT.md:** Added VPS-specific PM2 install instructions (`--prefix /data/.npm-global`)
- **PRODUCTION_SETUP.md:** Added VPS PM2 install section with persistent /data/ paths
- **PRODUCTION_SETUP.md:** Added VPS note about replacing workspace paths with /data/ equivalents
- **n8n-workflow-builder/TOOLS.md:** Populated with n8n API connection details and env var requirements

### n8n Integration Status
- n8n-workflow-builder agent exists but was a blank template (TOOLS.md had no config)
- Updated TOOLS.md with n8n URL (main.blackceoautomations.com), API key env var name, and auth header format
- Agent still needs: actual workflow templates, webhook URL configuration, and API integration testing
- n8n is NOT integrated with Command Center's task system — it's a standalone agent for building n8n workflows manually

## v2.9.0 - April 1, 2026

### Fixed
- config/departments.json: populated with 17 real departments (was empty [])
- Department IDs now use dept-[slug] format matching openclaw.json agent IDs
- Department schema corrected: id, emoji, name, headTitle, workspacePath fields
- Persona route path resolution fixed: strips dep- prefix for correct file lookup

### Added
- New department section components: CampaignSpotlightCard, ComplianceContextCard, DepartmentMemoryPreviewCard
- DeploymentHealthChart, EnvironmentStatusSection, GoalsConstraintsSection
- HRCultureSpotlight, HRTalentPipeline, HRVoiceCommand
- KPIStatCardsRow, LiveLogsSection, MarketingMemoryDefaults
- RepositoryStatusCard, ResearchInsightsSection, SupportDashboardExtras
- Creative and Operations sub-sections

## v2.4.0 - March 27, 2026

### Added - Intelligence Settings
- New Settings > Intelligence page (`/settings/intelligence`) for per-department model and persona configuration
- AI Settings quick panel in Header for fast model/persona switching per workspace
- `agent_settings` database table with migration 013 (department + role + setting_type + value)
- `/api/settings/intelligence` API endpoint for reading and writing agent settings
- Model options: Free Models Router, Kimi K2.5, MiMo V2 Pro, Claude Sonnet, GPT 5.4, Gemini 3 Flash
- Persona options: Auto-assign, James Clear, Seth Godin, Alex Hormozi, Donald Miller, Chris Voss

### Added - Complementary Brand Palette
- `src/lib/colors.ts`: HSL color utility library (hexToHsl, hslToHex, generatePalette)
- Generates light/dark/accent variants from company primary and secondary colors
- `useCompanyBrand` hook fetches company record and builds full brand palette dynamically
- All palette fields null-safe when brand colors are not yet configured

### Fixed - Dynamic Department Resolution
- `departments.config.ts` now filters departments against workspaces in the database instead of always returning all 17 defaults
- AgentsSidebar loads departments from `/api/workspaces` instead of hardcoded array
- Removed 18-entry hardcoded DEPARTMENTS constant from AgentsSidebar
- Resolution order: env var config > database workspaces > built-in fallback

### Fixed - Donut Chart Restore
- Rebuilt UtilizationPieChart as pure inline SVG (removed recharts dependency for this component)
- Animated donut with gradient stroke, center label, and legend row per department
- Responsive sizing with configurable width/height props

### Fixed - Scrollbar and Layout
- Header CSS updated with wider scrollbar styling and arrow indicators
- Custom scrollbar track/thumb/thumb-hover for AI settings panel overflow

### Fixed - Avatar and Agent Logic
- AgentsSidebar deduplicates agent entries and filters out system/default agents
- CEO role deduplication in agent roster display
- Agent description and department navigation links added

### Changed - CEO Board Layout
- Agent Performance section moved below the two-column department/analytics grid
- "View Department Performance" navigation card added with arrow CTA
- Removed standalone AgentPerformanceSection from CEO board main view

### Changed - Port Configuration
- dev and start scripts use `${PORT:-4000}` env var instead of hardcoded 4000
- Allows client machines to run on port 4000 while Trevor's machine uses 3000

### Infrastructure
- `agent_settings` table with unique constraint on (department_id, role_id, setting_type)
- Migration 013 adds indexes on department_id and role_id columns

## v2.3.0 - March 23, 2026

### Fixed - Dynamic Department Seeding
- Removed ALL hardcoded seed data (Acme Dental, Zero Human Workforce Demo)
- migrations.ts no longer inserts any companies or workspaces
- departments.json ships empty - Skill 23 generates it from client's interview answers
- seed-workspaces.py now reads dynamically from:
  1. config/departments.json (generated by Skill 23)
  2. Falls back to scanning Skill 23 workspace folders
  3. Reads company name from workforce-interview-answers.md
- No personal data, avatars, or branding in the template repo
- config/README.md added explaining the dynamic flow

### Fixed - Cloudflare Tunnel Setup
- Phase 6b uses Cloudflare REST API, not cloudflared CLI (cert.pem not needed)
- create-tunnel.sh script added for automated tunnel creation
- Webhook URL for DNS registration: https://main.blackceoautomations.com/webhook/command-center-register-v3
- Mandatory gate checks at every phase to prevent skipping

## v2.2.0 - March 22, 2026

### Added - Persona UI Integration
- DepartmentCard: activePersona field with violet persona indicator pill
- AgentPerformanceSection: persona pill on agent cards showing active persona per task
- AgentPerformanceSection: specialist type label (Full-time / On-call) per agent
- DevilsAdvocateFeed: persona field on challenges with "Acting as [persona]" display
- Agent type interface: persona and specialist_type fields added

### Added - API Endpoints
- GET /api/departments/[id]/personas: reads governing-personas.md from department workspace
- GET /api/org-chart: reads ORG-CHART.md from CEO workspace
- GET /api/persona-matrix: reads persona-matrix.md from CEO workspace
- Department sub-board fetches live personas before falling back to demo data

### Changed - Dynamic Departments
- Removed ALL hardcoded "17 departments" references from codebase
- CEODashboard: TOTAL_DEPARTMENTS_TARGET replaced with departments.length
- DepartmentPerformanceSection: "all 17 departments" changed to "all departments"
- departments.config.ts and seed-dept-memory.ts comments updated
- Demo persona list expanded to 10 accurate book author names

### Infrastructure
- Added version file (v2.2.0)

## v2.1.0 - March 22, 2026

### Added
- Version file added to repository

## v1.4.0 - March 21, 2026

### Added
- Multi-company schema support
- Per-department memory architecture
- KPI entry form
- Recommendation effectiveness tracking (90-day score)
- Execution queue (5pm-9am out-of-hours processing)
- Historical benchmarks with inline SVG sparklines (30-day trends)
- Model pills on agent cards

## v1.3.0 - March 21, 2026

### Added
- CompanyHealthHeader (letter grade + plain English explanation + dept badges)
- DepartmentCard (stat row, progress bar, status dot)
- DepartmentSubBoard page (/ceo-board/[dept])
- Navigation (back buttons, clickable dept cards)
- RecommendationEngineCard (Approve/Dismiss/Save for Later/Why buttons)
- RecommendationsSection (API, effectiveness stats, empty state)
- Approve-to-backlog Kanban integration
- Recommendations API (GET, POST approve/dismiss/save, SQLite seeding)
- AgentPerformanceSection (192 lines)
- DevilsAdvocateFeed (248 lines)
- DepartmentPerformanceSection (291 lines)
- ExecutionQueueSection
- BenchmarkingSection
- KPIEntryPanel
- ManualKPISection
- Sparkline component
- grading.ts utility

## v1.2.0 - March 21, 2026

### Fixed
- All Departments view shows all tasks instead of empty Kanban
- Routing: clicking All Departments no longer shows CEO Dashboard
- CEO Performance Board shows real metrics instead of zeros

### Added
- Task pills: Status, Priority, Department, Agent, Persona
- Persona values populated for all 111 tasks across departments
- Back to Dashboard button on Performance Board
- All Companies button on dashboard header

## v1.1.0 - March 20, 2026
- Department-based sidebar filtering
- CEO Performance Board with analytics
- Live activity feed
- Mobile responsive fixes
