import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DEPARTMENTS_CONFIG_PATH = join(process.cwd(), 'config', 'departments.json');

interface DepartmentEntry {
  id: string;
  emoji: string;
  name: string;
  headTitle: string;
}

async function readDepartments(): Promise<DepartmentEntry[]> {
  const raw = await readFile(DEPARTMENTS_CONFIG_PATH, 'utf-8');
  return JSON.parse(raw) as DepartmentEntry[];
}

// GET /api/departments — return current department list
export async function GET() {
  try {
    const departments = await readDepartments();
    return NextResponse.json({ success: true, departments });
  } catch {
    return NextResponse.json(
      { success: false, message: 'Failed to load departments configuration.' },
      { status: 500 }
    );
  }
}

// POST /api/departments — update a single department's name/emoji
// Body: { id: string; name?: string; emoji?: string; headTitle?: string }
export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON body.' },
      { status: 400 }
    );
  }

  const { id, name, emoji, headTitle } = body as Partial<DepartmentEntry>;

  if (!id || typeof id !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Missing required field: id' },
      { status: 400 }
    );
  }

  if (name !== undefined && typeof name !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Field "name" must be a string.' },
      { status: 400 }
    );
  }

  if (emoji !== undefined && typeof emoji !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Field "emoji" must be a string.' },
      { status: 400 }
    );
  }

  if (headTitle !== undefined && typeof headTitle !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Field "headTitle" must be a string.' },
      { status: 400 }
    );
  }

  try {
    const departments = await readDepartments();
    const index = departments.findIndex((d) => d.id === id);

    if (index === -1) {
      return NextResponse.json(
        { success: false, message: `Department with id "${id}" not found.` },
        { status: 404 }
      );
    }

    // Apply updates
    if (name !== undefined) departments[index].name = name.trim();
    if (emoji !== undefined) departments[index].emoji = emoji.trim();
    if (headTitle !== undefined) departments[index].headTitle = headTitle.trim();

    await writeFile(DEPARTMENTS_CONFIG_PATH, JSON.stringify(departments, null, 2), 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'Department updated successfully.',
      department: departments[index],
    });
  } catch {
    return NextResponse.json(
      { success: false, message: 'Failed to save departments configuration.' },
      { status: 500 }
    );
  }
}
