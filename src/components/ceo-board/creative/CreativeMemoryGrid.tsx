'use client';

import { motion, type Variants } from 'framer-motion';
import { Palette, Archive, BookOpen, Brain } from 'lucide-react';

interface MemoryCard {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  title: string;
  description: string;
  footer: React.ReactNode;
}

const CARDS: MemoryCard[] = [
  {
    icon: <Palette className="h-5 w-5" />,
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-700',
    title: 'Visual Identity',
    description: 'Style guides, logos, and color palettes for 2024 campaigns.',
    footer: (
      <div className="flex -space-x-2">
        <div className="w-8 h-8 rounded-full bg-brand-300 border-2 border-white" />
        <div className="w-8 h-8 rounded-full bg-amber-400 border-2 border-white" />
        <div className="w-8 h-8 rounded-full bg-emerald-500 border-2 border-white" />
        <div className="w-8 h-8 rounded-full bg-gray-300 border-2 border-white flex items-center justify-center text-[10px] font-bold text-gray-600">+4</div>
      </div>
    ),
  },
  {
    icon: <Archive className="h-5 w-5" />,
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-700',
    title: 'Campaign Archives',
    description: 'Historical performance data and creative assets from previous years.',
    footer: (
      <span className="text-xs font-bold uppercase tracking-widest text-emerald-600">
        12.4 GB Storage Used
      </span>
    ),
  },
  {
    icon: <BookOpen className="h-5 w-5" />,
    iconBg: 'bg-rose-100',
    iconColor: 'text-rose-700',
    title: 'Creative Guidelines',
    description: 'Standard operating procedures and tone of voice manuals.',
    footer: (
      <button className="text-xs font-black uppercase underline decoration-rose-300 hover:decoration-rose-600 transition-all text-rose-700">
        Download PDF
      </button>
    ),
  },
  {
    icon: <Brain className="h-5 w-5" />,
    iconBg: 'bg-indigo-100',
    iconColor: 'text-indigo-700',
    title: 'Department IQ',
    description: 'Custom LLM training data specific to our brand\'s unique narrative.',
    footer: (
      <span className="flex items-center gap-2 text-xs font-bold text-gray-500">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
        Syncing Active
      </span>
    ),
  },
];

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06 },
  },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1] as const },
  },
};

export default function CreativeMemoryGrid() {
  return (
    <div
      className="rounded-2xl shadow-sm border-0 p-8"
      style={{
        backgroundColor: 'rgba(255,255,255,0.88)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Department Memory</h2>
          <p className="text-sm text-gray-500">Project assets and historical institutional knowledge</p>
        </div>
        <button className="px-5 py-2 bg-gray-100 rounded-full text-sm font-bold text-gray-700 hover:bg-gray-200 transition-colors">
          View All
        </button>
      </div>

      <motion.div
        className="grid grid-cols-1 sm:grid-cols-2 gap-6"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {CARDS.map((card) => (
          <motion.div
            key={card.title}
            variants={cardVariants}
            className="bg-gray-50 p-6 rounded-xl hover:bg-gray-100 transition-all group cursor-default"
          >
            <div className={`w-12 h-12 rounded-full ${card.iconBg} flex items-center justify-center mb-5 ${card.iconColor}`}>
              {card.icon}
            </div>
            <h4 className="font-bold text-lg mb-2 text-gray-900">{card.title}</h4>
            <p className="text-sm text-gray-500 mb-5">{card.description}</p>
            {card.footer}
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
