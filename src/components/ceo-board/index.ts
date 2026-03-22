// CEO Performance Board - Component Exports
// Analytics Charts Section + Department Performance

// Analytics Components
export { AnalyticsSection, type AnalyticsData } from './AnalyticsSection';
export { CompletionBarChart } from './CompletionBarChart';
export { UtilizationPieChart } from './UtilizationPieChart';
export { VelocityLineChart } from './VelocityLineChart';

// Department Components
export { DepartmentPerformanceSection } from './DepartmentPerformanceSection';
export { DepartmentGrid } from './DepartmentGrid';
export { DepartmentCard, type DepartmentPerformance, type DepartmentStatus } from './DepartmentCard';
export { FilterTabs, type FilterTab } from './FilterTabs';

// Benchmark Section
export { BenchmarkingSection } from './BenchmarkingSection';
export { ComparisonBar } from './ComparisonBar';
export { RecommendationsSection } from './RecommendationsSection';
export { RecommendationCard } from './RecommendationCard';
export { ManualKPISection } from './ManualKPISection';
export { ExecutionQueueSection } from './ExecutionQueueSection';

// Health Section (re-export from health/)
export * from './health';
