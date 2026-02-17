# Pages - Component Dependency Trees

## / (Home - Workspace Selection)
**Entry:** `src/app/page.tsx`

**Dependencies:**
- src/components/WorkspaceDashboard.tsx
  - src/lib/types.ts (WorkspaceStats)
  - lucide-react (Plus, ArrowRight, Folder, Users, CheckSquare, Trash2, AlertTriangle)
  - next/link

**Context files for this page:**
```
--context-file src/app/page.tsx
--context-file src/components/WorkspaceDashboard.tsx
--context-file src/lib/types.ts
--context-file src/app/globals.css
--context-file tailwind.config.ts
```

---

## /workspace/[slug] (Main Dashboard)
**Entry:** `src/app/workspace/[slug]/page.tsx`

**Dependencies:**
- src/components/Header.tsx
  - src/lib/store.ts
  - src/lib/types.ts (Workspace)
  - lucide-react (Settings, ChevronLeft, LayoutGrid)
  - date-fns (format)
- src/components/AgentsSidebar.tsx
  - src/lib/store.ts
  - src/lib/types.ts (Agent, AgentStatus, OpenClawSession)
  - src/components/AgentModal.tsx
  - lucide-react (Plus, ChevronRight, ChevronLeft, Zap, ZapOff, Loader2)
- src/components/MissionQueue.tsx
  - src/lib/store.ts
  - src/lib/types.ts (Task, TaskStatus)
  - src/lib/auto-dispatch.ts
  - src/components/TaskModal.tsx
  - lucide-react (Plus, ChevronRight, GripVertical)
  - date-fns (formatDistanceToNow)
- src/components/LiveFeed.tsx
  - src/lib/store.ts
  - src/lib/types.ts (Event)
  - lucide-react (ChevronRight, ChevronLeft, Clock)
  - date-fns (formatDistanceToNow)
- src/components/SSEDebugPanel.tsx
- src/hooks/useSSE.ts
- src/lib/debug.ts

**Context files for this page:**
```
--context-file src/app/workspace/[slug]/page.tsx
--context-file src/components/Header.tsx
--context-file src/components/AgentsSidebar.tsx
--context-file src/components/MissionQueue.tsx
--context-file src/components/LiveFeed.tsx
--context-file src/components/AgentModal.tsx
--context-file src/components/TaskModal.tsx
--context-file src/lib/store.ts
--context-file src/lib/types.ts
--context-file src/app/globals.css
--context-file tailwind.config.ts
```

---

## Component-Level Dependencies

### AgentModal
**File:** `src/components/AgentModal.tsx`
**Imports:**
- lucide-react (X, Save, Trash2)
- src/lib/store.ts
- src/lib/types.ts (Agent, AgentStatus)

### TaskModal
**File:** `src/components/TaskModal.tsx`
**Imports:**
- lucide-react (X, Save, Trash2, Plus)
- src/lib/store.ts
- src/lib/types.ts (Task, TaskStatus, TaskPriority, Agent)

### DemoBanner
**File:** `src/components/DemoBanner.tsx`
**Imports:** (none - self-contained)

---

## Icons Used

From lucide-react:
- Settings, ChevronLeft, ChevronRight, LayoutGrid
- Plus, Zap, ZapOff, Loader2
- ArrowRight, Folder, Users, CheckSquare, Trash2, AlertTriangle
- GripVertical, Clock
- X, Save
