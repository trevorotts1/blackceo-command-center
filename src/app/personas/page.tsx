'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, BookOpen, Tag, Search } from 'lucide-react';
import { Header } from '@/components/Header';

interface PersonaItem {
  id: string;
  author: string;
  book: string;
  domain: string[];
  perspective: string[];
  custom: string[];
  category: string;
  blueprint_preview: string;
}

export default function PersonasPage() {
  const [personas, setPersonas] = useState<PersonaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch('/api/personas');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { personas: PersonaItem[] };
        setPersonas(data.personas || []);
      } catch (err) {
        console.error(err);
        setError('Failed to load persona library.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const categories = useMemo(() => {
    const set = new Set<string>();
    personas.forEach((p) => set.add(p.category));
    return ['all', ...Array.from(set).sort()];
  }, [personas]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return personas.filter((p) => {
      if (selectedCategory !== 'all' && p.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        p.id.includes(q) ||
        p.author.toLowerCase().includes(q) ||
        p.book.toLowerCase().includes(q) ||
        p.domain.some((d) => d.toLowerCase().includes(q)) ||
        p.perspective.some((d) => d.toLowerCase().includes(q))
      );
    });
  }, [personas, query, selectedCategory]);

  const grouped = useMemo(() => {
    const map = new Map<string, PersonaItem[]>();
    for (const p of filtered) {
      const list = map.get(p.category) || [];
      list.push(p);
      map.set(p.category, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="flex h-screen flex-col bg-bcc-bg">
      <Header />
      <main className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
        <div className="mx-auto w-full max-w-7xl space-y-6">
          <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
            <p className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
              Persona Library
            </p>
            <h1 className="text-3xl font-bold text-gray-900 sm:text-4xl">
              Book-to-Persona Coaching Library
            </h1>
            <p className="mt-3 text-base text-gray-500 sm:text-lg">
              {personas.length} personas across {categories.length - 1} categories. Each persona
              is a coaching/leadership lens sourced from a published book and used by
              persona-selector-v2 to assign the right voice to each task.
            </p>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by author, book, domain..."
                  className="w-full rounded-xl border border-gray-200 bg-white px-10 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </div>

              <div className="flex flex-wrap gap-1.5">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      selectedCategory === cat
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {cat === 'all' ? 'All' : cat}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {loading && (
            <div className="flex min-h-[200px] items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50">
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
              <span className="ml-2 text-sm text-gray-500">Loading personas...</span>
            </div>
          )}

          {!loading && error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-5 text-sm text-red-700">
              {error}
            </div>
          )}

          {!loading && !error && personas.length === 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-5 text-sm text-amber-900">
              No personas were loaded from persona-categories.json. This usually means the
              Book-to-Persona skill (Skill 22) is not installed on this server. Run the
              onboarding installer or copy persona-categories.json into the skills directory.
            </div>
          )}

          {!loading && !error && grouped.map(([category, items]) => (
            <section key={category} className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-xl font-bold text-gray-900 sm:text-2xl">{category}</h2>
                <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600">
                  {items.length} {items.length === 1 ? 'persona' : 'personas'}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {items.map((p) => (
                  <article
                    key={p.id}
                    className="rounded-2xl border border-gray-200 bg-gray-50 p-4 transition-all hover:border-indigo-300 hover:bg-white hover:shadow-md"
                  >
                    <header className="mb-3 flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-gray-900">{p.author}</h3>
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-gray-500">
                          <BookOpen className="h-3 w-3" /> {p.book}
                        </p>
                      </div>
                      <code className="rounded bg-white px-2 py-0.5 text-[10px] text-indigo-600">
                        {p.id}
                      </code>
                    </header>

                    <p className="mb-3 text-xs leading-5 text-gray-600">{p.blueprint_preview}</p>

                    {p.domain.length > 0 && (
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        <Tag className="h-3 w-3 text-indigo-500" />
                        {p.domain.map((d) => (
                          <span
                            key={d}
                            className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700"
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                    )}

                    {p.perspective.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {p.perspective.map((d) => (
                          <span
                            key={d}
                            className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
                          >
                            {d}
                          </span>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
