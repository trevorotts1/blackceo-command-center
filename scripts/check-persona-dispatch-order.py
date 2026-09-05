#!/usr/bin/env python3
"""Both send rails must gate current persona before the durable reservation."""
from pathlib import Path
for name in ('src/lib/task-dispatcher.ts', 'src/app/api/tasks/[id]/dispatch/route.ts'):
    source = Path(name).read_text()
    assert source.index('const personaReady = checkPersonaDispatchReady') < source.index('const claim = reserveExecution'), name
