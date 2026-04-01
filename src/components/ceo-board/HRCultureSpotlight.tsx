'use client';

import { motion } from 'framer-motion';

interface CultureSpotlightData {
  badge: string;
  headline: string;
  body: string;
  imageUrl?: string;
  ctaLabel: string;
  onCta?: () => void;
}

const DEFAULT_SPOTLIGHT: CultureSpotlightData = {
  badge: 'Culture Spotlight',
  headline: 'Engineering Wellness Week',
  body: 'Next week, the engineering department moves to a mandatory "No-Meeting Wednesday" to foster deep work and reduce burnout scores which rose slightly last month.',
  ctaLabel: 'Coordinate Session',
};

function HRCultureSpotlight({ data }: { data?: CultureSpotlightData }) {
  const spot = data || DEFAULT_SPOTLIGHT;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="bg-white rounded-2xl shadow-sm p-6 sm:p-8 relative overflow-hidden flex flex-col md:flex-row gap-6 items-center"
    >
      <div className="flex-1">
        <span className="inline-block bg-emerald-50 text-emerald-700 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider">
          {spot.badge}
        </span>
        <h3 className="text-2xl sm:text-3xl font-bold text-gray-900 mt-3 mb-3">
          {spot.headline}
        </h3>
        <p className="text-sm text-gray-600 leading-relaxed mb-6">
          {spot.body}
        </p>
        <button
          onClick={spot.onCta}
          className="bg-gray-900 text-white px-5 py-2.5 rounded-full font-semibold text-sm hover:bg-gray-800 transition-all active:scale-95"
        >
          {spot.ctaLabel}
        </button>
      </div>
      {spot.imageUrl ? (
        <div className="w-full md:w-56 h-40 rounded-xl overflow-hidden relative flex-shrink-0">
          <img
            src={spot.imageUrl}
            alt={spot.headline}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-gray-900/30 to-transparent" />
        </div>
      ) : (
        <div className="w-full md:w-56 h-40 rounded-xl overflow-hidden relative flex-shrink-0 bg-gradient-to-br from-emerald-50 to-emerald-100 flex items-center justify-center">
          <span className="text-5xl">🌿</span>
        </div>
      )}
    </motion.div>
  );
}

export { HRCultureSpotlight };
export default HRCultureSpotlight;
