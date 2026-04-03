import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DEPARTMENTS_CONFIG_PATH = join(process.cwd(), 'config', 'departments.json');

interface DepartmentEntry {
  id: string;
  emoji: string;
  name: string;
  headTitle: string;
  workspacePath?: string;
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

// POST /api/departments — create or update a department
// Body: { id: string; name?: string; emoji?: string; headTitle?: string; workspacePath?: string; create?: boolean }
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

  const { id, name, emoji, headTitle, workspacePath, create } = body as Partial<DepartmentEntry> & { create?: boolean };

  if (!id || typeof id !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Missing required field: id' },
      { status: 400 }
    );
  }

  // Validation for create mode
  if (create) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { success: false, message: 'Missing required field for create: name' },
        { status: 400 }
      );
    }
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

    // Handle create mode
    if (create) {
      if (index !== -1) {
        return NextResponse.json(
          { success: false, message: `Department with id "${id}" already exists.` },
          { status: 409 }
        );
      }

      const newDepartment: DepartmentEntry = {
        id,
        name: name!.trim(),
        emoji: emoji?.trim() || '📁',
        headTitle: headTitle?.trim() || 'Department Head',
        workspacePath: workspacePath || `departments/${id}`,
      };

      departments.push(newDepartment);
      await writeFile(DEPARTMENTS_CONFIG_PATH, JSON.stringify(departments, null, 2), 'utf-8');

      return NextResponse.json({
        success: true,
        message: 'Department created successfully.',
        department: newDepartment,
      }, { status: 201 });
    }

    // Handle update mode
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
    if (workspacePath !== undefined) departments[index].workspacePath = workspacePath;

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

// DELETE /api/departments?id={id} — delete a department
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json(
      { success: false, message: 'Missing required query parameter: id' },
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

    const deletedDepartment = departments[index];
    departments.splice(index, 1);
    await writeFile(DEPARTMENTS_CONFIG_PATH, JSON.stringify(departments, null, 2), 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'Department deleted successfully.',
      department: deletedDepartment,
    });
  } catch {
    return NextResponse.json(
      { success: false, message: 'Failed to delete department.' },
      { status: 500 }
    );
  }
}
