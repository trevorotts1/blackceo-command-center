'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, TrendingUp, DollarSign, Users, Percent } from 'lucide-react';

interface KpiSnapshot {
  id: string;
  kpi_id: string;
  kpi_name: string;
  value: number;
  target: number | null;
  unit: string;
  snapshot_date: string;
}

interface KpiEntryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface KpiFormData {
  'new-leads': string;
  'new-clients': string;
  'monthly-revenue': string;
  'conversion-rate': string;
}

const companyKPIs = [
  { id: 'new-leads', name: 'New Leads This Week', target: 50, unit: 'count', icon: Users },
  { id: 'new-clients', name: 'New Paying Clients', target: 10, unit: 'count', icon: Users },
  { id: 'monthly-revenue', name: 'Monthly Revenue', target: 50000, unit: 'currency', icon: DollarSign },
  { id: 'conversion-rate', name: 'Lead Conversion Rate', target: 20, unit: 'percent', icon: Percent },
];

export function KPIEntryPanel({ isOpen, onClose, onSaved }: KpiEntryPanelProps) {
  const [formData, setFormData] = useState<KpiFormData>({
    'new-leads': '',
    'new-clients': '',
    'monthly-revenue': '',
    'conversion-rate': '',
  });
  const [currentValues, setCurrentValues] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);

  // Fetch current KPI values when panel opens
  useEffect(() => {
    if (isOpen) {
      fetchCurrentValues();
    }
  }, [isOpen]);

  const fetchCurrentValues = async () => {
    setIsFetching(true);
    try {
      const response = await fetch('/api/kpi-snapshots?department_id=company&days=7');
      if (response.ok) {
        const data = await response.json();
        const latestValues: Record<string, number> = {};
        
        // Get the most recent value for each KPI
        for (const snapshot of data.latest || []) {
          latestValues[snapshot.kpi_id] = snapshot.value;
        }
        
        setCurrentValues(latestValues);
        
        // Pre-fill form with current values
        setFormData({
          'new-leads': latestValues['new-leads']?.toString() || '',
          'new-clients': latestValues['new-clients']?.toString() || '',
          'monthly-revenue': latestValues['monthly-revenue']?.toString() || '',
          'conversion-rate': latestValues['conversion-rate']?.toString() || '',
        });
      }
    } catch (error) {
      console.error('Failed to fetch current KPI values:', error);
    } finally {
      setIsFetching(false);
    }
  };

  const handleInputChange = (kpiId: string, value: string) => {
    // Only allow numbers and decimals
    if (value === '' || /^\d*\.?\d*$/.test(value)) {
      setFormData((prev) => ({ ...prev, [kpiId]: value }));
    }
  };

  const handleSave = async () => {
    setIsLoading(true);
    const today = new Date().toISOString().split('T')[0];
    
    try {
      // Save each KPI value
      const savePromises = companyKPIs.map(async (kpi) => {
        const value = parseFloat(formData[kpi.id as keyof KpiFormData]);
        if (isNaN(value)) return; // Skip empty values

        const response = await fetch('/api/kpi-snapshots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kpi_id: kpi.id,
            kpi_name: kpi.name,
            value,
            target: kpi.target,
            unit: kpi.unit,
            department_id: 'company',
            snapshot_date: today,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to save ${kpi.name}`);
        }
      });

      await Promise.all(savePromises);
      
      onSaved();
      onClose();
    } catch (error) {
      console.error('Failed to save KPI values:', error);
      alert('Failed to save some values. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const formatValue = (value: number, unit: string) => {
    if (unit === 'currency') {
      return `$${value.toLocaleString()}`;
    }
    if (unit === 'percent') {
      return `${value}%`;
    }
    return value.toLocaleString();
  };

  const getInputPrefix = (unit: string) => {
    if (unit === 'currency') return '$';
    if (unit === 'percent') return '';
    return '';
  };

  const getInputSuffix = (unit: string) => {
    if (unit === 'percent') return '%';
    return '';
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/30 z-40"
            onClick={onClose}
          />

          {/* Slide-in Panel */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center">
                  <TrendingUp className="w-5 h-5 text-[#6366F1]" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Update My Numbers</h2>
                  <p className="text-sm text-gray-500">Enter your weekly KPI data</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 hover:bg-gray-100 rounded-full transition-colors"
              >
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            {/* Form Content */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              {isFetching ? (
                <div className="flex items-center justify-center h-32">
                  <div className="w-8 h-8 border-2 border-indigo-200 border-t-[#6366F1] rounded-full animate-spin" />
                </div>
              ) : (
                <div className="space-y-6">
                  {companyKPIs.map((kpi) => {
                    const Icon = kpi.icon;
                    const currentValue = currentValues[kpi.id];
                    const hasCurrentValue = currentValue !== undefined;

                    return (
                      <div key={kpi.id} className="space-y-2">
                        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                          <Icon className="w-4 h-4 text-gray-400" />
                          {kpi.name}
                        </label>
                        
                        <div className="relative">
                          {getInputPrefix(kpi.unit) && (
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-medium">
                              {getInputPrefix(kpi.unit)}
                            </span>
                          )}
                          <input
                            type="text"
                            inputMode="decimal"
                            value={formData[kpi.id as keyof KpiFormData]}
                            onChange={(e) => handleInputChange(kpi.id, e.target.value)}
                            placeholder="0"
                            className={`w-full bg-white border border-gray-200 rounded-lg px-3 py-3 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6366F1] focus:border-transparent transition-all ${
                              getInputPrefix(kpi.unit) ? 'pl-8' : ''
                            } ${getInputSuffix(kpi.unit) ? 'pr-8' : ''}`}
                          />
                          {getInputSuffix(kpi.unit) && (
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 font-medium">
                              {getInputSuffix(kpi.unit)}
                            </span>
                          )}
                        </div>

                        {/* Target and current value info */}
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-400">
                            Target: {formatValue(kpi.target, kpi.unit)}
                          </span>
                          {hasCurrentValue && (
                            <span className="text-gray-500">
                              Current: {formatValue(currentValue, kpi.unit)}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer Actions */}
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50">
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  disabled={isLoading}
                  className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={isLoading}
                  className="flex-1 px-4 py-2.5 bg-[#6366F1] text-white font-medium rounded-lg hover:bg-indigo-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Saving...
                    </>
                  ) : (
                    'Save Numbers'
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
