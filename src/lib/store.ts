'use client';

import { useState, useEffect } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { debug } from './debug';
import type { Agent, Task, Conversation, Message, Event, TaskStatus, OpenClawSession } from './types';

interface MissionControlState {
  // Data
  agents: Agent[];
  tasks: Task[];
  conversations: Conversation[];
  events: Event[];
  currentConversation: Conversation | null;
  messages: Message[];

  // OpenClaw state
  agentOpenClawSessions: Record<string, OpenClawSession | null>; // agentId -> session
  openclawMessages: Message[]; // Messages from OpenClaw (displayed alongside regular messages)

  // UI State
  selectedAgent: Agent | null;
  selectedTask: Task | null;
  isOnline: boolean;
  isLoading: boolean;
  selectedBusiness: string;
  selectedDepartment: string | null;

  // Actions
  setAgents: (agents: Agent[]) => void;
  setTasks: (tasks: Task[]) => void;
  setConversations: (conversations: Conversation[]) => void;
  setEvents: (events: Event[]) => void;
  addEvent: (event: Event) => void;
  setCurrentConversation: (conversation: Conversation | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  setSelectedAgent: (agent: Agent | null) => void;
  setSelectedTask: (task: Task | null) => void;
  setIsOnline: (online: boolean) => void;
  setIsLoading: (loading: boolean) => void;
  setSelectedBusiness: (business: string) => void;
  setSelectedDepartment: (department: string | null) => void;

  // Task mutations
  updateTaskStatus: (taskId: string, status: TaskStatus) => void;
  updateTask: (task: Task) => void;
  addTask: (task: Task) => void;

  // Agent mutations
  updateAgent: (agent: Agent) => void;
  addAgent: (agent: Agent) => void;

  // OpenClaw actions
  setAgentOpenClawSession: (agentId: string, session: OpenClawSession | null) => void;
  setOpenclawMessages: (messages: Message[]) => void;
  addOpenclawMessage: (message: Message) => void;
}

export const useMissionControl = create<MissionControlState>()(
  persist(
    (set) => ({
      // Initial state
      agents: [],
      tasks: [],
      conversations: [],
      events: [],
      currentConversation: null,
      messages: [],
      agentOpenClawSessions: {},
      openclawMessages: [],
      selectedAgent: null,
      selectedTask: null,
      isOnline: true,
      isLoading: true,
      selectedBusiness: 'all',
      selectedDepartment: null,

      // Setters
      setAgents: (agents) => set({ agents }),
      setTasks: (tasks) => {
        debug.store('setTasks called', { count: tasks.length });
        set({ tasks });
      },
      setConversations: (conversations) => set({ conversations }),
      setEvents: (events) => set({ events }),
      addEvent: (event) =>
        set((state) => ({ events: [event, ...state.events].slice(0, 100) })),
      setCurrentConversation: (conversation) => set({ currentConversation: conversation }),
      setMessages: (messages) => set({ messages }),
      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),
      setSelectedAgent: (agent) => set({ selectedAgent: agent }),
      setSelectedTask: (task) => {
        debug.store('setSelectedTask called', { id: task?.id, status: task?.status });
        set({ selectedTask: task });
      },
      setIsOnline: (online) => {
        debug.store('setIsOnline called', { online });
        set({ isOnline: online });
      },
      setIsLoading: (loading) => set({ isLoading: loading }),
      setSelectedBusiness: (business) => set({ selectedBusiness: business }),
      setSelectedDepartment: (department) => set({ selectedDepartment: department }),

      // Task mutations
      updateTaskStatus: (taskId, status) => {
        debug.store('updateTaskStatus called', { taskId, status });
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId ? { ...task, status } : task
          ),
        }));
      },
      updateTask: (updatedTask) => {
        debug.store('updateTask called', { id: updatedTask.id, status: updatedTask.status });
        set((state) => {
          const oldTask = state.tasks.find(t => t.id === updatedTask.id);
          if (oldTask) {
            debug.store('Task state change', {
              id: updatedTask.id,
              oldStatus: oldTask.status,
              newStatus: updatedTask.status
            });
          } else {
            debug.store('Task not found in store, adding', { id: updatedTask.id });
          }
          return {
            tasks: state.tasks.map((task) =>
              task.id === updatedTask.id ? updatedTask : task
            ),
          };
        });
      },
      addTask: (task) => {
        debug.store('addTask called', { id: task.id, title: task.title });
        set((state) => {
          // Dedupe: don't add if already exists
          if (state.tasks.some((t) => t.id === task.id)) {
            debug.store('Task already exists, skipping add', { id: task.id });
            return state;
          }
          return { tasks: [task, ...state.tasks] };
        });
      },

      // Agent mutations
      updateAgent: (updatedAgent) =>
        set((state) => ({
          agents: state.agents.map((agent) =>
            agent.id === updatedAgent.id ? updatedAgent : agent
          ),
        })),
      addAgent: (agent) => set((state) => ({ agents: [...state.agents, agent] })),

      // OpenClaw actions
      setAgentOpenClawSession: (agentId, session) =>
        set((state) => ({
          agentOpenClawSessions: { ...state.agentOpenClawSessions, [agentId]: session },
        })),
      setOpenclawMessages: (messages) => set({ openclawMessages: messages }),
      addOpenclawMessage: (message) =>
        set((state) => ({ openclawMessages: [...state.openclawMessages, message] })),
    }),
    {
      name: 'mission-control-storage',
      storage: createJSONStorage(() => localStorage),
      // Only persist UI state, not data that should be fetched fresh
      partialize: (state) => ({
        selectedBusiness: state.selectedBusiness,
        selectedDepartment: state.selectedDepartment,
      }),
    }
  )
);

// Export a hook to check hydration status for components that need it
export const useStoreHydrated = () => {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const unsub = useMissionControl.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    // Check if already hydrated
    if (useMissionControl.persist.hasHydrated()) {
      setHydrated(true);
    }
    return unsub;
  }, []);
  return hydrated;
};
