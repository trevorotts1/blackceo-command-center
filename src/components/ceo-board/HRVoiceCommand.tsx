'use client';

import { motion } from 'framer-motion';
import { Mic } from 'lucide-react';

interface VoiceCommandData {
  prompt: string;
  isActive?: boolean;
}

const DEFAULT_VOICE: VoiceCommandData = {
  prompt: 'Show me all employees who haven\'t completed the diversity training...',
  isActive: true,
};

export function HRVoiceCommand({ data }: { data?: VoiceCommandData }) {
  const voice = data || DEFAULT_VOICE;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
      className="bg-white rounded-2xl shadow-sm p-5 border border-gray-100"
    >
      <div className="flex items-center gap-3 mb-4">
        <div className={`h-8 w-8 rounded-full flex items-center justify-center ${voice.isActive ? 'bg-gray-900 animate-pulse' : 'bg-gray-200'}`}>
          <Mic className={`h-4 w-4 ${voice.isActive ? 'text-white' : 'text-gray-500'}`} />
        </div>
        <h4 className="font-bold text-xs uppercase tracking-widest text-gray-500">
          Voice Command
        </h4>
      </div>
      <p className="text-sm font-medium text-gray-700 italic mb-5 leading-relaxed">
        &ldquo;{voice.prompt}&rdquo;
      </p>
      {/* Audio waveform visualization */}
      <div className="flex items-center gap-1">
        {[4, 12, 20, 8, 16, 4].map((h, i) => (
          <div
            key={i}
            className="w-[7px] rounded-full bg-gray-900 transition-all"
            style={{ height: `${h}px` }}
          />
        ))}
      </div>
    </motion.div>
  );
}
