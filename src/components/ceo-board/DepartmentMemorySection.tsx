'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, Plus, X, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import type { DeptMemory, MemoryType } from '@/lib/types';

const MEMORY_TYPE_CONFIG: Record<MemoryType, { label: string; color: string; bgColor: string; borderColor: string; icon: string }> = {
  goal: { label: 'Goals', color: 'text-emerald-700', bgColor: 'bg-emerald-50', borderColor: 'border-emerald-200', icon: '🎯' },
  constraint: { label: 'Constraints', color: 'text-rose-700', bgColor: 'bg-rose-50', borderColor: 'border-rose-200', icon: '🚧' },
  context: { label: 'Context', color: 'text-indigo-700', bgColor: 'bg-indigo-50', borderColor: 'border-indigo-200', icon: '📋' },
  decision: { label: 'Decisions', color: 'text-amber-700', bgColor: 'bg-amber-50', borderColor: 'border-amber-200', icon: '✅' },
  lesson: { label: 'Lessons', color: 'text-purple-700', bgColor: 'bg-purple-50', borderColor: 'border-purple-200', icon: '💡' },
};

const IMPORTANCE_COLORS: Record<number, string> = {
  5: 'bg-rose-500',
  4: 'bg-amber-500',
  3: 'bg-indigo-500',
  2: 'bg-gray-400',
  1: 'bg-gray-300',
};

function ImportanceDot({ level }: { level: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${
            i <= level ? IMPORTANCE_COLORS[level] : 'bg-gray-200'
          }`}
        />
      ))}
    </div>
  );
}

function MemoryCard({
  memory,
  onDelete,
}: {
  memory: DeptMemory;
  onDelete: (id: string) => void;
}) {
  const config = MEMORY_TYPE_CONFIG[memory.memory_type] || MEMORY_TYPE_CONFIG.context;
  const date = new Date(memory.created_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={`bg-white rounded-xl border ${config.borderColor} p-4 hover:shadow-sm transition-shadow group`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-gray-800 leading-relaxed flex-1">{memory.content}</p>
        <button
          onClick={() => onDelete(memory.id)}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-gray-400 hover:text-rose-500"
          title="Delete memory"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-100">
        <span className="text-xs text-gray-400">{date}</span>
        <ImportanceDot level={memory.importance} />
      </div>
    </motion.div>
  );
}

function AddMemoryForm({
  workspaceId,
  onAdded,
  onCancel,
}: {
  workspaceId: string;
  onAdded: (memory: DeptMemory) => void;
  onCancel: () => void;
}) {
  const [content, setContent] = useState('');
  const [memoryType, setMemoryType] = useState<MemoryType>('goal');
  const [importance, setImportance] = useState(3);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    setSubmitting(true);
    try {
      const res = await fetch('/api/dept-memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          memory_type: memoryType,
          content: content.trim(),
          importance,
        }),
      });
      const json = await res.json();
      if (json.success && json.data) {
        onAdded(json.data);
        setContent('');
      }
    } catch (err) {
      console.error('Failed to add memory:', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.form
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      onSubmit={handleSubmit}
      className="bg-white rounded-xl border border-gray-200 p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-900">Add Department Memory</h4>
        <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="What should this department remember?"
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-none"
        rows={2}
      />
      <div className="flex items-center gap-3">
        <select
          value={memoryType}
          onChange={(e) => setMemoryType(e.target.value as MemoryType)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
        >
          {Object.entries(MEMORY_TYPE_CONFIG).map(([key, cfg]) => (
            <option key={key} value={key}>{cfg.label}</option>
          ))}
        </select>
        <select
          value={importance}
          onChange={(e) => setImportance(Number(e.target.value))}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
        >
          <option value={5}>Critical (5)</option>
          <option value={4}>High (4)</option>
          <option value={3}>Medium (3)</option>
          <option value={2}>Low (2)</option>
          <option value={1}>Minor (1)</option>
        </select>
        <button
          type="submit"
          disabled={submitting || !content.trim()}
          className="ml-auto px-4 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? 'Adding...' : 'Add Memory'}
        </button>
      </div>
    </motion.form>
  );
}

export default function DepartmentMemorySection({ workspaceId }: { workspaceId: string }) {
  const [memories, setMemories] = useState<DeptMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [expandedTypes, setExpandedTypes] = useState<Set<MemoryType>>(new Set<MemoryType>(['goal', 'constraint', 'context', 'lesson', 'decision'] as MemoryType[]));

  const fetchMemories = useCallback(async () => {
    try {
      const res = await fetch(`/api/dept-memory?workspace_id=${workspaceId}`);
      const json = await res.json();
      if (json.data) {
        setMemories(json.data);
      }
    } catch (err) {
      console.error('Failed to fetch dept memories:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchMemories();
  }, [fetchMemories]);

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/dept-memory/${id}`, { method: 'DELETE' });
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      console.error('Failed to delete memory:', err);
    }
  };

  const handleAdded = (memory: DeptMemory) => {
    setMemories((prev) => [memory, ...prev]);
    setShowForm(false);
  };

  const toggleType = (type: MemoryType) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  // Group memories by type
  const grouped = memories.reduce((acc, mem) => {
    if (!acc[mem.memory_type]) acc[mem.memory_type] = [];
    acc[mem.memory_type].push(mem);
    return acc;
  }, {} as Record<string, DeptMemory[]>);

  const typeOrder: MemoryType[] = ['goal', 'constraint', 'context', 'decision', 'lesson'];
  const displayTypes = typeOrder.filter((t) => grouped[t]?.length > 0);

  if (loading) {
    return (
      <section>
        <div className="flex items-center gap-3 mb-4">
          <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-purple-50 text-purple-600">
            <Brain className="h-5 w-5" />
          </div>
          <h2 className="text-xl font-bold text-gray-900">Department Memory</h2>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <div className="h-6 w-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-gray-500 mt-3">Loading memories...</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-purple-50 text-purple-600">
            <Brain className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900">Department Memory</h2>
            <p className="text-xs text-gray-400">{memories.length} memories stored</p>
          </div>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Memory
        </button>
      </div>

      <div className="space-y-4">
        <AnimatePresence>
          {showForm && (
            <AddMemoryForm
              workspaceId={workspaceId}
              onAdded={handleAdded}
              onCancel={() => setShowForm(false)}
            />
          )}
        </AnimatePresence>

        {displayTypes.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <Brain className="h-8 w-8 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">No memories yet</p>
            <p className="text-sm text-gray-400 mt-1">Click &quot;Add Memory&quot; to start building this department&apos;s knowledge base.</p>
          </div>
        ) : (
          displayTypes.map((type) => {
            const config = MEMORY_TYPE_CONFIG[type];
            const items = grouped[type] || [];
            const isExpanded = expandedTypes.has(type);

            return (
              <div key={type} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <button
                  onClick={() => toggleType(type)}
                  className={`w-full flex items-center justify-between px-4 py-3 ${config.bgColor} border-b ${config.borderColor}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{config.icon}</span>
                    <span className={`text-sm font-semibold ${config.color}`}>{config.label}</span>
                    <span className="text-xs text-gray-400 bg-white/60 px-2 py-0.5 rounded-full">{items.length}</span>
                  </div>
                  {isExpanded ? (
                    <ChevronUp className={`h-4 w-4 ${config.color}`} />
                  ) : (
                    <ChevronDown className={`h-4 w-4 ${config.color}`} />
                  )}
                </button>
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0 }}
                      animate={{ height: 'auto' }}
                      exit={{ height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="p-4 space-y-3">
                        {items.map((mem) => (
                          <MemoryCard key={mem.id} memory={mem} onDelete={handleDelete} />
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
