import { NextResponse } from 'next/server';

export async function GET() {
  try {
    return NextResponse.json({
      demo: process.env.DEMO_MODE === 'true',
      message: process.env.DEMO_MODE === 'true'
        ? 'This is a live demo of Command Center. All actions are simulated.'
        : undefined,
      github: 'https://github.com/crshdn/mission-control',
    });
  } catch (error) {
    console.error('Failed to fetch demo status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch demo status' },
      { status: 500 }
    );
  }
}
