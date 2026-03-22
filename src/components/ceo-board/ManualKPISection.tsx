'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { DollarSign, Users, TrendingUp, Target, Save, CheckCircle } from 'lucide-react';

interface KpiField {
  id: string;
  name: string;
  label: string;
  placeholder: string;
  icon: typeof DollarSign;
  prefix: string;
  suffix: string;
  target: number;
  unit: string;
}

const KPI_FIELDS: KpiField[] = [
  {
    id: 'monthly-revenue',
    name: 'Monthly Revenue',
    label: 'Monthly Revenue',
    placeholder: '0',
    icon: DollarSign,
    prefix: '$',
    suffix: '',
    target: 50000,
    unit: 'currency',
  },
  {
    id: 'monthly-expenses',
    name: 'Monthly Expenses',
    label: 'Monthly Expenses',
    placeholder: '0',
    icon: DollarSign,
    prefix: '$',
    suffix: '',
    target: 30000,
    unit: 'currency',
  },
  {
    id: 'active-clients',
    name: 'Active Clients',
    label: 'Active Clients',
    placeholder: '0',
    icon: Users,
    prefix: '',
    suffix: '',
    target: 50,
    unit: 'count',
  },
  {
    id: 'new-leads',
    name: 'New Leads This Month',
    label: 'New Leads This Month',
    placeholder: '0',
    icon: Target,
    prefix: '',
    suffix: '',
    target: 100,
    unit: 'count',
  },
];

export function ManualKPISection() {
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [currentValues, setCurrentValues] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [saved, setSaved] = useState(false);

  const fetchCurrentValues = useCallback(async () => {
    setIsFetching(true);
    try {
      const response = await fetch('/api/kpi-snapshots?department_id=company&days=90');
      if (response.ok) {
        const data = await response.json();
        const latestValues: Record<string, number> = {};
        for (const snapshot of data.latest || []) {
          latestValues[snapshot.kpi_id] = snapshot.value;
        }
        setCurrentValues(latestValues);
        setFormData({
          'monthly-revenue': latestValues['monthly-revenue']?.toString() || '',
          'monthly-expenses': latestValues['monthly-expenses']?.toString() || '',
          'active-clients': latestValues['active-clients']?.toString() || '',
          'new-leads': latestValues['new-leads']?.toString() || '',
        });
      }
    } catch (error) {
      console.error('Failed to fetch current KPI values:', error);
    } finally {
      setIsFetching(false);
    }
  }, []);

  useEffect(() => {
    fetchCurrentValues();
  }, [fetchCurrentValues]);

  const handleInputChange = (fieldId: string, value: string) => {
    if (value === '' || /^\d*\.?\d*$/.test(value)) {
      setFormData((prev) => ({ ...prev, [fieldId]: value }));
      setSaved(false);
    }
  };

  const handleSave = async () => {
    setIsLoading(true);
    setSaved(false);
    const today = new Date().toISOString().split('T')[0];

    try {
      const savePromises = KPI_FIELDS.map(async (field) => {
        const raw = formData[field.id];
        if (!raw) return;
        const value = parseFloat(raw);
        if (isNaN(value)) return;

        const response = await fetch('/api/kpi-snapshots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kpi_id: field.id,
            kpi_name: field.name,
            value,
            target: field.target,
            unit: field.unit,
            department_id: 'company',
            snapshot_date: today,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to save ${field.name}`);
        }
      });

      await Promise.all(savePromises);
      await fetchCurrentValues();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      console.error('Failed to save KPI values:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const formatCurrency = (value: number) =>
    '$' + value.toLocaleString();

  const hasValues = Object.values(formData).some((v) => v !== '');

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2 }}
      className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden"
    >
      {/* Header */}
      <div className="px-6 py-5 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center">
            <TrendingUp className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Update My Numbers
            </h2>
            <p className="text-sm text-gray-500">
              Manually enter your key metrics to keep your performance grade accurate
            </p>
          </div>
        </div>
      </div>

      {/* Form Body */}
      <div className="px-6 py-6">
        {isFetching ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-8 h-8 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {KPI_FIELDS.map((field) => {
              const Icon = field.icon;
              const currentValue = currentValues[field.id];
              const hasCurrent = currentValue !== undefined;

              return (
                <div key={field.id} className="space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                    <Icon className="w-4 h-4 text-gray-400" />
                    {field.label}
                  </label>

                  <div className="relative">
                    {field.prefix && (
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-medium text-sm">
                        {field.prefix}
                      </span>
                    )}
                    <input
                      type="text"
                      inputMode="decimal"
                      value={formData[field.id] || ''}
                      onChange={(e) => handleInputChange(field.id, e.target.value)}
                      placeholder={field.placeholder}
                      className={`w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent focus:bg-white transition-all text-sm ${
                        field.prefix ? 'pl-8' : ''
                      } ${field.suffix ? 'pr-8' : ''}`}
                    />
                    {field.suffix && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 font-medium text-sm">
                        {field.suffix}
                      </span>
                    )}
                  </div>

                  {hasCurrent && (
                    <p className="text-xs text-gray-400">
                      Last saved: {field.unit === 'currency'
                        ? formatCurrency(currentValue)
                        : currentValue.toLocaleString()}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between">
        {saved ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex items-center gap-2 text-emerald-600 text-sm font-medium"
          >
            <CheckCircle className="w-4 h-4" />
            Numbers saved successfully
          </motion.div>
        ) : (
          <span className="text-xs text-gray-400">
            Values update your dashboard grades in real time
          </span>
        )}

        <button
          onClick={handleSave}
          disabled={isLoading || !hasValues}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              Save
            </>
          )}
        </button>
      </div>
    </motion.div>
  );
}
