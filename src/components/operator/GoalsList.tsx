'use client';

/**
 * GoalsList — CRUD UI for the Operator Console Goals sub-module.
 *
 * Track B6 (PRD Section 4.7).
 *
 * Responsibilities:
 *   - Render the goals returned by /api/operator/goals
 *   - Add: title plus optional category and body
 *   - Toggle complete via checkbox
 *   - Edit title/body inline
 *   - Delete with a soft confirmation
 *
 * The mirror to `<vault>/goals.md` is handled server-side. The UI never
 * touches the filesystem.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Loader2, Trash2, Save, X, Check, ChevronDown } from 'lucide-react';

interface Goal {
  id: string;
  category: string | null;
  title: string;
  body: string | null;
  completed: boolean;
  completed_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  items: Goal[];
  total: number;
}

export default function GoalsList() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-goal form state
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [newBody, setNewBody] = useState('');
  const [showBody, setShowBody] = useState(false);
  const [adding, setAdding] = useState(false);

  // Filter state
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [showCompleted, setShowCompleted] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const url = new URL('/api/operator/goals', window.location.origin);
      if (filterCategory) url.searchParams.set('category', filterCategory);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = (await res.json()) as ListResponse;
      setGoals(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  }, [filterCategory]);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const g of goals) if (g.category) set.add(g.category);
    return Array.from(set).sort();
  }, [goals]);

  const visible = useMemo(() => {
    return goals.filter((g) => (showCompleted ? true : !g.completed));
  }, [goals, showCompleted]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title || adding) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          body: newBody.trim() || null,
          category: newCategory.trim() || null,
        }),
      });
      if (!res.ok) throw new Error(`Add failed (${res.status})`);
      setNewTitle('');
      setNewCategory('');
      setNewBody('');
      setShowBody(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(goal: Goal) {
    try {
      const res = await fetch(`/api/operator/goals/${goal.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ completed: !goal.completed }),
      });
      if (!res.ok) throw new Error(`Toggle failed (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    }
  }

  async function handleSaveEdit(goal: Goal, patch: { title?: string; body?: string | null }) {
    try {
      const res = await fetch(`/api/operator/goals/${goal.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    }
  }

  async function handleDelete(goal: Goal) {
    if (!window.confirm(`Delete goal: "${goal.title}"?`)) return;
    try {
      const res = await fetch(`/api/operator/goals/${goal.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleAdd}
        className="rounded-xl border border-bcc-border bg-bcc-white p-4"
        aria-label="Add new goal"
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New goal..."
            disabled={adding}
            className="flex-1 min-w-[200px] rounded-lg border border-bcc-border bg-bcc-bg px-3 py-2 text-[15px] outline-none focus:border-bcc-text"
            aria-label="Goal title"
          />
          <input
            type="text"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="Category (optional)"
            disabled={adding}
            list="goal-categories"
            className="w-44 rounded-lg border border-bcc-border bg-bcc-bg px-3 py-2 text-[13px] outline-none focus:border-bcc-text"
            aria-label="Goal category"
          />
          <datalist id="goal-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <button
            type="button"
            onClick={() => setShowBody((v) => !v)}
            className="inline-flex items-center gap-1 text-[12px] text-bcc-text-secondary hover:text-bcc-text px-2 py-2"
          >
            <ChevronDown size={14} className={showBody ? 'rotate-180 transition-transform' : 'transition-transform'} />
            Notes
          </button>
          <button
            type="submit"
            disabled={adding || !newTitle.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-bcc-text px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Add
          </button>
        </div>
        {showBody ? (
          <textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder="Optional markdown notes for this goal..."
            disabled={adding}
            rows={3}
            className="mt-3 w-full rounded-lg border border-bcc-border bg-bcc-bg px-3 py-2 text-[14px] outline-none focus:border-bcc-text"
          />
        ) : null}
      </form>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <label className="text-[12px] uppercase tracking-[0.18em] text-bcc-text-muted">Category</label>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="rounded-md border border-bcc-border bg-bcc-white px-2 py-1 text-[13px]"
          >
            <option value="">All</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="ml-3 inline-flex items-center gap-2 text-[13px] text-bcc-text-secondary">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
            />
            Show completed
          </label>
        </div>
        <div className="text-[12px] text-bcc-text-muted">
          {visible.length} of {goals.length}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700" role="alert">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-bcc-text-muted text-[14px]">
          <Loader2 size={14} className="animate-spin" />
          Loading goals...
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-bcc-border bg-bcc-white p-8 text-center text-bcc-text-muted text-[14px]">
          No goals yet. Add your first one above.
        </div>
      ) : (
        <ul className="space-y-2" aria-label="Goals list">
          {visible.map((goal) => (
            <GoalRow
              key={goal.id}
              goal={goal}
              onToggle={() => handleToggle(goal)}
              onSave={(patch) => handleSaveEdit(goal, patch)}
              onDelete={() => handleDelete(goal)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function GoalRow({
  goal,
  onToggle,
  onSave,
  onDelete,
}: {
  goal: Goal;
  onToggle: () => void;
  onSave: (patch: { title?: string; body?: string | null }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(goal.title);
  const [draftBody, setDraftBody] = useState(goal.body || '');

  useEffect(() => {
    setDraftTitle(goal.title);
    setDraftBody(goal.body || '');
  }, [goal.id, goal.title, goal.body]);

  function commit() {
    const patch: { title?: string; body?: string | null } = {};
    if (draftTitle.trim() && draftTitle.trim() !== goal.title) {
      patch.title = draftTitle.trim();
    }
    const nextBody = draftBody.trim() || null;
    if (nextBody !== (goal.body || null)) {
      patch.body = nextBody;
    }
    if (Object.keys(patch).length > 0) {
      onSave(patch);
    }
    setEditing(false);
  }

  return (
    <li
      id={goal.id}
      className="rounded-xl border border-bcc-border bg-bcc-white p-3 transition-colors"
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label={goal.completed ? 'Mark incomplete' : 'Mark complete'}
          className={`mt-0.5 grid place-items-center w-5 h-5 rounded border ${
            goal.completed
              ? 'bg-bcc-text text-white border-bcc-text'
              : 'border-bcc-border-light hover:border-bcc-text'
          }`}
        >
          {goal.completed ? <Check size={12} /> : null}
        </button>
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="space-y-2">
              <input
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                className="w-full rounded-md border border-bcc-border bg-bcc-bg px-2 py-1 text-[15px]"
                aria-label="Edit title"
              />
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={3}
                placeholder="Notes..."
                className="w-full rounded-md border border-bcc-border bg-bcc-bg px-2 py-1 text-[13px]"
                aria-label="Edit body"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={commit}
                  className="inline-flex items-center gap-1 rounded-md bg-bcc-text px-3 py-1 text-[12px] text-white"
                >
                  <Save size={12} /> Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraftTitle(goal.title);
                    setDraftBody(goal.body || '');
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-bcc-border px-3 py-1 text-[12px] text-bcc-text-secondary"
                >
                  <X size={12} /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="block w-full text-left"
              aria-label="Edit goal"
            >
              <div
                className={`text-[15px] ${
                  goal.completed ? 'line-through text-bcc-text-muted' : 'text-bcc-text'
                }`}
              >
                {goal.title}
              </div>
              {goal.body ? (
                <div className="mt-1 whitespace-pre-wrap text-[13px] text-bcc-text-secondary">
                  {goal.body}
                </div>
              ) : null}
              <div className="mt-1 flex items-center gap-2 text-[11px] text-bcc-text-muted">
                {goal.category ? (
                  <span className="rounded-full bg-bcc-border-light px-2 py-0.5">{goal.category}</span>
                ) : null}
                <span>Updated {new Date(goal.updated_at).toLocaleDateString()}</span>
                {goal.completed_at ? (
                  <span>Completed {new Date(goal.completed_at).toLocaleDateString()}</span>
                ) : null}
              </div>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete goal"
          className="text-bcc-text-muted hover:text-red-600 p-1 rounded transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  );
}
