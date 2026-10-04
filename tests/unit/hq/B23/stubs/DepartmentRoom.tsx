/**
 * TEST-ONLY stub for `./DepartmentRoom` (B24's owned module, not on disk in the
 * B23 worktree). Loaded only through `floor-stub-register.mjs`; never shipped and
 * never imported by product code.
 *
 * It reports exactly the props Floor passes — the department, the room geometry
 * and the selected flag — plus one button per selectable entity, so the test
 * proves Floor hands down real roster/geometry objects and real callbacks.
 * B24's drawing, label and status behavior is proved by B24's own tests.
 */
import { createElement } from 'react';
import type { HqDepartment, HqRoomLayout } from '@/lib/hq/types';

export type DepartmentRoomProps = {
  department: HqDepartment;
  room: HqRoomLayout;
  selected?: boolean;
  onSelectDepartment?: (workspaceId: string) => void;
  onSelectAgent?: (agentId: string) => void;
};

export default function DepartmentRoom({
  department,
  room,
  selected = false,
  onSelectDepartment,
  onSelectAgent,
}: DepartmentRoomProps) {
  const firstAgent = department.agents[0];
  return createElement(
    'div',
    {
      'data-testid': `stub-room-${department.id}`,
      'data-room-workspace': room.workspaceId,
      'data-room-selected': selected ? 'true' : 'false',
      'data-room-seats': String(room.seats.length),
      'data-room-height': String(room.height),
      'data-room-name': department.name,
      'data-room-head': department.headAgentId ?? 'none',
      'data-room-slugs': department.agents.map((agent) => agent.id).join(','),
    },
    createElement(
      'button',
      {
        key: 'dept',
        type: 'button',
        'data-testid': `stub-room-select-${department.id}`,
        onClick: () => onSelectDepartment?.(department.id),
      },
      department.name,
    ),
    firstAgent
      ? createElement(
          'button',
          {
            key: 'agent',
            type: 'button',
            'data-testid': `stub-room-agent-${firstAgent.id}`,
            onClick: () => onSelectAgent?.(firstAgent.id),
          },
          firstAgent.id,
        )
      : null,
  );
}
