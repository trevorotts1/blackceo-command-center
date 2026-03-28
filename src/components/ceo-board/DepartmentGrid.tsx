'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { DepartmentCard, DepartmentPerformance } from './DepartmentCard';
import { FilterTab } from './FilterTabs';
import { Loader2 } from 'lucide-react';

interface DepartmentGridProps {
  departments: DepartmentPerformance[];
  filter: FilterTab;
  isLoading?: boolean;
}

export function DepartmentGrid({ departments, filter, isLoading }: DepartmentGridProps) {
  const filteredDepartments = useMemo(() => {
    if (filter === 'all') return departments;
    return departments.filter((dept) => dept.status === filter);
  }, [departments, filter]);

  if (isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/50">
        <div className="flex flex-col items-center gap-3 text-gray-500">
          <Loader2 className="h-8 w-8 animate-spin" />
          <span className="text-base font-medium">Loading departments...</span>
        </div>
      </div>
    );
  }

  if (filteredDepartments.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/50"
      >
        <div className="text-center">
          <p className="text-gray-500 font-medium">No departments found</p>
          <p className="text-sm text-gray-400 mt-1">
            Try adjusting your filter selection
          </p>
        </div>
      </motion.div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
      {filteredDepartments.map((department, index) => (
        <Link key={department.id} href={`/ceo-board/${department.id}`} className="block">
          <DepartmentCard
            department={department}
            index={index}
          />
        </Link>
      ))}
    </div>
  );
}