'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Building2, Users, Bot, ArrowRight, Activity, BarChart3 } from 'lucide-react';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { format } from 'date-fns';

interface Company {
  id: string;
  name: string;
  description: string;
  departments: number;
  agents: number;
  status: 'active' | 'inactive';
  gradient: string;
}

const companies: Company[] = [
  {
    id: 'blackceo',
    name: 'BlackCEO Operations',
    description: 'Primary company operations and management hub',
    departments: 17,
    agents: 24,
    status: 'active',
    gradient: 'from-indigo-500 via-purple-500 to-pink-500',
  },
  {
    id: 'acme-dental',
    name: 'Acme Dental',
    description: 'Client dental practice management workspace',
    departments: 17,
    agents: 12,
    status: 'active',
    gradient: 'from-emerald-400 via-teal-500 to-cyan-500',
  },
  {
    id: 'zhw-demo',
    name: 'Zero Human Workforce Demo',
    description: 'Autonomous AI workforce demonstration environment',
    departments: 17,
    agents: 48,
    status: 'active',
    gradient: 'from-amber-400 via-orange-500 to-red-500',
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
      delayChildren: 0.1,
    },
  },
};

const cardVariants = {
  hidden: { 
    opacity: 0, 
    y: 30,
    scale: 0.95,
  },
  visible: { 
    opacity: 1, 
    y: 0,
    scale: 1,
    transition: {
      type: 'spring' as const,
      stiffness: 100,
      damping: 15,
    },
  },
};

export default function CompanySelectorPage() {
  const router = useRouter();
  const logoUrl = useLogoUrl();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Check dashboard API health (not gateway - CEO cares about data availability)
  useEffect(() => {
    async function checkConnection() {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch('/api/workspaces', { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeoutId);
        setIsOnline(res.ok);
      } catch {
        setIsOnline(false);
      }
    }
    checkConnection();
    // Recheck every 60 seconds
    const interval = setInterval(checkConnection, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleCompanySelect = (companyId: string) => {
    router.push('/workspace/default');
  };

  return (
    <div className="min-h-screen bg-[#F8F9FB] flex flex-col">
      {/* Header */}
      <header className="h-16 bg-white border-b border-gray-200 px-6 flex items-center justify-between">
        {/* Left: Logo & Title */}
        <div className="flex items-center gap-4">
          {logoUrl ? (
            <img src={logoUrl} alt="BlackCEO" className="h-9 w-auto" />
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center">
                <Building2 className="w-5 h-5 text-white" />
              </div>
              <span className="text-gray-900 font-bold text-xl tracking-tight">BlackCEO</span>
            </div>
          )}
          <div className="h-6 w-px bg-gray-200 mx-2" />
          <h1 className="text-gray-900 font-semibold text-lg">Command Center</h1>
        </div>

        {/* Center: CEO Performance Board Button */}
        <motion.button
          onClick={() => router.push('/ceo-board')}
          className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl font-medium text-sm shadow-lg shadow-indigo-200 hover:shadow-xl hover:shadow-indigo-300 transition-all duration-300"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          <BarChart3 className="w-4 h-4" />
          CEO Performance Board
        </motion.button>

        {/* Right: Time & Status */}
        <div className="flex items-center gap-4">
          <span className="text-gray-500 text-sm font-mono">
            {format(currentTime, 'MMM d, HH:mm:ss')}
          </span>
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium ${
              isOnline
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'
              }`}
            />
            {isOnline ? 'LIVE' : 'OFFLINE'}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <motion.div
          className="max-w-6xl w-full"
          initial="hidden"
          animate="visible"
          variants={containerVariants}
        >
          {/* Title Section */}
          <motion.div className="text-center mb-12" variants={cardVariants}>
            <h2 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
              Select a Company
            </h2>
            <p className="text-gray-500 text-lg max-w-xl mx-auto">
              Choose your organization to access the mission control dashboard
            </p>
          </motion.div>

          {/* Company Cards Grid */}
          <motion.div 
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
            variants={containerVariants}
          >
            {companies.map((company) => (
              <motion.button
                key={company.id}
                onClick={() => handleCompanySelect(company.id)}
                className="group relative w-full text-left"
                variants={cardVariants}
                whileHover={{ 
                  scale: 1.03,
                  transition: { type: 'spring' as const, stiffness: 300, damping: 20 }
                }}
                whileTap={{ scale: 0.98 }}
              >
                {/* Card Background with Gradient */}
                <div className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${company.gradient} p-6 sm:p-8 h-full min-h-[280px] flex flex-col shadow-xl shadow-gray-200/50 group-hover:shadow-2xl group-hover:shadow-gray-300/50 transition-shadow duration-300`}>
                  {/* Decorative Circles */}
                  <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/10 rounded-full blur-2xl" />
                  <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-black/5 rounded-full blur-xl" />
                  
                  {/* Content */}
                  <div className="relative z-10 flex flex-col h-full">
                    {/* Status Badge */}
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-white/20 backdrop-blur-sm rounded-full">
                        <span className={`w-2 h-2 rounded-full ${company.status === 'active' ? 'bg-emerald-400 animate-pulse' : 'bg-gray-400'}`} />
                        <span className="text-white/90 text-xs font-medium uppercase tracking-wider">
                          {company.status}
                        </span>
                      </div>
                      <Building2 className="w-6 h-6 text-white/60" />
                    </div>

                    {/* Company Name */}
                    <h3 className="text-white font-bold text-2xl sm:text-3xl mb-2 leading-tight">
                      {company.name}
                    </h3>

                    {/* Description */}
                    <p className="text-white/80 text-sm mb-6 line-clamp-2">
                      {company.description}
                    </p>

                    {/* Stats Row */}
                    <div className="flex items-center gap-4 mt-auto">
                      {/* Departments Badge */}
                      <div className="flex items-center gap-2 px-3 py-2 bg-white/15 backdrop-blur-sm rounded-xl">
                        <Users className="w-4 h-4 text-white/80" />
                        <span className="text-white font-semibold text-sm">{company.departments}</span>
                        <span className="text-white/60 text-xs">depts</span>
                      </div>

                      {/* Agents Badge */}
                      <div className="flex items-center gap-2 px-3 py-2 bg-white/15 backdrop-blur-sm rounded-xl">
                        <Bot className="w-4 h-4 text-white/80" />
                        <span className="text-white font-semibold text-sm">{company.agents}</span>
                        <span className="text-white/60 text-xs">agents</span>
                      </div>
                    </div>

                    {/* Enter Button - appears on hover */}
                    <motion.div 
                      className="mt-6 flex items-center gap-2 text-white font-medium"
                      initial={{ opacity: 0.7, x: 0 }}
                      whileHover={{ opacity: 1, x: 4 }}
                    >
                      <span className="text-sm">Enter Dashboard</span>
                      <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-200" />
                    </motion.div>
                  </div>
                </div>
              </motion.button>
            ))}
          </motion.div>

          {/* Footer Info */}
          <motion.div 
            className="mt-12 text-center"
            variants={cardVariants}
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-full text-gray-500 text-sm">
              <Activity className="w-4 h-4 text-indigo-500" />
              <span>All systems operational</span>
              <span className="w-1 h-1 bg-gray-300 rounded-full" />
              <span>v1.1.0</span>
            </div>
          </motion.div>
        </motion.div>
      </main>
    </div>
  );
}
