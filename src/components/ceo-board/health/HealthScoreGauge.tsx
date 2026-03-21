'use client';

import { motion, useSpring, useTransform } from 'framer-motion';
import { useEffect, useState } from 'react';

interface HealthScoreGaugeProps {
  score: number;
  size?: number;
}

export function HealthScoreGauge({ score, size = 200 }: HealthScoreGaugeProps) {
  const [isMounted, setIsMounted] = useState(false);
  
  // Spring animation for smooth number counting
  const springScore = useSpring(0, {
    stiffness: 50,
    damping: 20,
    duration: 1.5,
  });
  
  const displayScore = useTransform(springScore, (latest) => Math.round(latest));
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    setIsMounted(true);
    springScore.set(score);
  }, [score, springScore]);

  useEffect(() => {
    const unsubscribe = displayScore.on('change', (latest) => {
      setDisplayValue(latest);
    });
    return () => unsubscribe();
  }, [displayScore]);

  // Calculate color based on score
  const getScoreColor = (value: number) => {
    if (value >= 85) return { main: '#4F46E5', light: '#818CF8', gradient: ['#4F46E5', '#7C3AED'] }; // Indigo
    if (value >= 70) return { main: '#10B981', light: '#34D399', gradient: ['#10B981', '#059669'] }; // Emerald
    if (value >= 50) return { main: '#F59E0B', light: '#FBBF24', gradient: ['#F59E0B', '#D97706'] }; // Amber
    return { main: '#DC2626', light: '#F87171', gradient: ['#DC2626', '#B91C1C'] }; // Red
  };

  const colors = getScoreColor(score);

  // SVG parameters
  const strokeWidth = 16;
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const arcLength = circumference * 0.75; // 270 degrees arc
  const strokeDashoffset = circumference - arcLength;

  // Calculate the score arc position
  const scoreOffset = circumference - (arcLength * score) / 100;

  // Generate gradient ID
  const gradientId = `gauge-gradient-${score}`;

  if (!isMounted) {
    return <div style={{ width: size, height: size }} />;
  }

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="transform -rotate-[135deg]"
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={colors.gradient[0]} />
            <stop offset="100%" stopColor={colors.gradient[1]} />
          </linearGradient>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Background track */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#E5E7EB"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${arcLength} ${circumference - arcLength}`}
          strokeDashoffset={strokeDashoffset}
        />

        {/* Animated score arc */}
        <motion.circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${arcLength} ${circumference - arcLength}`}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: scoreOffset }}
          transition={{
            duration: 1.5,
            ease: [0.25, 0.1, 0.25, 1] as [number, number, number, number],
            delay: 0.3,
          }}
          style={{
            filter: 'url(#glow)',
          }}
        />

        {/* Decorative tick marks */}
        {[0, 25, 50, 75, 100].map((tick, index) => {
          const angle = (tick / 100) * 270 - 135;
          const tickRadius = radius - strokeWidth / 2 - 8;
          const x1 = center + (tickRadius - 4) * Math.cos((angle * Math.PI) / 180);
          const y1 = center + (tickRadius - 4) * Math.sin((angle * Math.PI) / 180);
          const x2 = center + (tickRadius + 4) * Math.cos((angle * Math.PI) / 180);
          const y2 = center + (tickRadius + 4) * Math.sin((angle * Math.PI) / 180);

          return (
            <motion.line
              key={tick}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#9CA3AF"
              strokeWidth={2}
              strokeLinecap="round"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.5 + index * 0.1 }}
            />
          );
        })}
      </svg>

      {/* Center content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <motion.span
          className="text-5xl font-bold"
          style={{ color: colors.main }}
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{
            duration: 0.5,
            delay: 0.5,
            type: 'spring',
            stiffness: 200,
          }}
        >
          {displayValue}
        </motion.span>
        <motion.span
          className="text-sm font-medium text-gray-400 mt-1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1 }}
        >
          Score
        </motion.span>
      </div>

      {/* Pulse animation for excellent scores */}
      {score >= 85 && (
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{
            border: `2px solid ${colors.light}`,
          }}
          animate={{
            scale: [1, 1.05, 1],
            opacity: [0.5, 0, 0.5],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      )}
    </div>
  );
}
