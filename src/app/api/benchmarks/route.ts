import { NextRequest, NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';

// Industry benchmark constants
const BENCHMARKS: Record<string, { kpi_name: string; benchmark: number; unit: string }[]> = {
  marketing: [
    { kpi_name: 'Cost Per Lead', benchmark: 28, unit: 'currency' },
    { kpi_name: 'Conversion Rate', benchmark: 18, unit: 'percent' },
    { kpi_name: 'Email Open Rate', benchmark: 22, unit: 'percent' },
    { kpi_name: 'Social Reach', benchmark: 35000, unit: 'count' },
  ],
  sales: [
    { kpi_name: 'Lead Response Time', benchmark: 6, unit: 'count' },
    { kpi_name: 'Conversion Rate', benchmark: 18, unit: 'percent' },
    { kpi_name: 'Deals Closed', benchmark: 8, unit: 'count' },
    { kpi_name: 'Pipeline Value', benchmark: 200000, unit: 'currency' },
  ],
  support: [
    { kpi_name: 'Avg Resolution Time', benchmark: 24, unit: 'count' },
    { kpi_name: 'CSAT Score', benchmark: 82, unit: 'percent' },
    { kpi_name: 'First Contact Resolution', benchmark: 71, unit: 'percent' },
    { kpi_name: 'Tickets Resolved', benchmark: 120, unit: 'count' },
  ],
  hr: [
    { kpi_name: 'Retention Rate', benchmark: 85, unit: 'percent' },
    { kpi_name: 'Time to Hire', benchmark: 28, unit: 'count' },
    { kpi_name: 'Employee Satisfaction', benchmark: 74, unit: 'percent' },
    { kpi_name: 'Onboarding Completion', benchmark: 78, unit: 'percent' },
  ],
  billing: [
    { kpi_name: 'Collection Rate', benchmark: 88, unit: 'percent' },
    { kpi_name: 'Processing Time', benchmark: 48, unit: 'count' },
    { kpi_name: 'Invoice Accuracy', benchmark: 95, unit: 'percent' },
  ],
  operations: [
    { kpi_name: 'Process Automation', benchmark: 55, unit: 'percent' },
    { kpi_name: 'Task Throughput', benchmark: 12, unit: 'count' },
    { kpi_name: 'System Downtime', benchmark: 5, unit: 'count' },
  ],
  creative: [
    { kpi_name: 'Content Output', benchmark: 15, unit: 'count' },
    { kpi_name: 'Quality Score', benchmark: 80, unit: 'percent' },
    { kpi_name: 'Brand Consistency', benchmark: 75, unit: 'percent' },
  ],
  legal: [
    { kpi_name: 'Compliance Score', benchmark: 90, unit: 'percent' },
    { kpi_name: 'Contract Review Time', benchmark: 72, unit: 'count' },
  ],
  it: [
    { kpi_name: 'System Uptime', benchmark: 99.0, unit: 'percent' },
    { kpi_name: 'Incidents Resolved', benchmark: 10, unit: 'count' },
    { kpi_name: 'Patch Compliance', benchmark: 85, unit: 'percent' },
  ],
  webdev: [
    { kpi_name: 'Deploy Frequency', benchmark: 5, unit: 'count' },
    { kpi_name: 'Build Success Rate', benchmark: 90, unit: 'percent' },
    { kpi_name: 'Page Load Time', benchmark: 3.5, unit: 'count' },
  ],
  appdev: [
    { kpi_name: 'Features Shipped', benchmark: 4, unit: 'count' },
    { kpi_name: 'Avg Bug Fix Time', benchmark: 48, unit: 'count' },
    { kpi_name: 'Test Coverage', benchmark: 75, unit: 'percent' },
  ],
  graphics: [
    { kpi_name: 'Design Output', benchmark: 20, unit: 'count' },
    { kpi_name: 'Client Approval Rate', benchmark: 75, unit: 'percent' },
  ],
  video: [
    { kpi_name: 'Production Volume', benchmark: 8, unit: 'count' },
    { kpi_name: 'Avg Render Time', benchmark: 45, unit: 'count' },
  ],
  audio: [
    { kpi_name: 'Production Volume', benchmark: 6, unit: 'count' },
    { kpi_name: 'Quality Score', benchmark: 80, unit: 'percent' },
  ],
  research: [
    { kpi_name: 'Reports Delivered', benchmark: 4, unit: 'count' },
    { kpi_name: 'Insights Actioned', benchmark: 50, unit: 'percent' },
  ],
  comms: [
    { kpi_name: 'Response Rate', benchmark: 65, unit: 'percent' },
    { kpi_name: 'Media Mentions', benchmark: 10, unit: 'count' },
  ],
  ceo: [
    { kpi_name: 'Strategic Progress', benchmark: 60, unit: 'percent' },
    { kpi_name: 'Cross-Dept Coordination', benchmark: 65, unit: 'percent' },
  ],
};

// GET /api/benchmarks?industry=general&department=marketing
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const department = searchParams.get('department');

    if (department) {
      const benchmarks = BENCHMARKS[department] || [];
      return NextResponse.json({
        success: true,
        department,
        benchmarks,
      });
    }

    // Return all benchmarks
    return NextResponse.json({
      success: true,
      industry: searchParams.get('industry') || 'general',
      benchmarks: BENCHMARKS,
    });
  } catch (error) {
    console.error('GET /api/benchmarks error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch benchmarks' },
      { status: 500 }
    );
  }
}
