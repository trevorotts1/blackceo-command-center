'use client';

import { motion } from 'framer-motion';

interface CampaignSpotlightCardProps {
  title?: string;
  label?: string;
  imageUrl?: string;
}

const DEFAULT_IMAGE = 'https://images.unsplash.com/photo-1552664730-d307ca884978?w=800&q=80';

export default function CampaignSpotlightCard({
  title = 'The BlackCEO Summit 2025',
  label = 'Campaign Spotlight',
  imageUrl,
}: CampaignSpotlightCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
      className="relative group overflow-hidden rounded-2xl h-56 shadow-lg"
    >
      <img
        src={imageUrl || DEFAULT_IMAGE}
        alt={title}
        className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-gray-900/80 via-gray-900/30 to-transparent flex items-end p-6">
        <div>
          <span className="text-xs font-bold text-amber-300 uppercase tracking-widest mb-1.5 block">
            {label}
          </span>
          <h4 className="text-white font-bold text-xl leading-tight">
            {title}
          </h4>
        </div>
      </div>
    </motion.div>
  );
}
