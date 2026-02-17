'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, Circle, Lock, AlertCircle, Loader2, X } from 'lucide-react';

interface PlanningOption {
  id: string;
  label: string;
}

interface PlanningQuestion {
  question: string;
  options: PlanningOption[];
}

interface PlanningMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface PlanningState {
  taskId: string;
  sessionKey?: string;
  messages: PlanningMessage[];
  currentQuestion?: PlanningQuestion;
  isComplete: boolean;
  dispatchError?: string;
  spec?: {
    title: string;
    summary: string;
    deliverables: string[];
    success_criteria: string[];
    constraints: Record<string, unknown>;
  };
  agents?: Array<{
    name: string;
    role: string;
    avatar_emoji: string;
    soul_md: string;
    instructions: string;
  }>;
  isStarted: boolean;
}

interface PlanningTabProps {
  taskId: string;
  onSpecLocked?: () => void;
}

export function PlanningTab({ taskId, onSpecLocked }: PlanningTabProps) {
  const [state, setState] = useState<PlanningState | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [retryingDispatch, setRetryingDispatch] = useState(false);
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false);

  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);
  const lastSubmissionRef = useRef<{ answer: string; otherText?: string } | null>(null);
  const currentQuestionRef = useRef<string | undefined>(undefined);

  const loadState = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`);
      if (res.ok) {
        const data = await res.json();
        setState(data);
        currentQuestionRef.current = data.currentQuestion?.question;
      }
    } catch (err) {
      console.error('Failed to load planning state:', err);
      setError('Failed to load planning state');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
    setIsWaitingForResponse(false);
  }, []);

  const pollForUpdates = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/poll`);
      if (res.ok) {
        const data = await res.json();

        if (data.hasUpdates) {
          setState(prev => ({
            ...prev!,
            messages: data.messages,
            isComplete: data.complete,
            spec: data.spec,
            agents: data.agents,
            currentQuestion: data.currentQuestion,
            dispatchError: data.dispatchError,
          }));

          const questionChanged = currentQuestionRef.current !== data.currentQuestion?.question;
          
          if (data.currentQuestion) {
            currentQuestionRef.current = data.currentQuestion.question;
          }

          if (questionChanged) {
            setSelectedOption(null);
            setOtherText('');
            setIsSubmittingAnswer(false);
          }

          if (data.dispatchError) {
            setError(`Planning completed but dispatch failed: ${data.dispatchError}`);
          }

          if (data.complete && onSpecLocked) {
            onSpecLocked();
          }

          setIsWaitingForResponse(false);
          stopPolling();
        }
      }
    } catch (err) {
      console.error('Failed to poll for updates:', err);
    } finally {
      isPollingRef.current = false;
    }
  }, [taskId, onSpecLocked, stopPolling, setState, setError, setIsSubmittingAnswer, setSelectedOption, setOtherText]);

  const startPolling = useCallback(() => {
    stopPolling();
    setIsWaitingForResponse(true);

    pollingIntervalRef.current = setInterval(() => {
      pollForUpdates();
    }, 2000);

    pollingTimeoutRef.current = setTimeout(() => {
      stopPolling();
      setError('The orchestrator is taking too long to respond. Please try submitting again or refresh the page.');
    }, 30000);
  }, [pollForUpdates, stopPolling]);

  useEffect(() => {
    if (state?.currentQuestion) {
      currentQuestionRef.current = state.currentQuestion.question;
    }
  }, [state]);

  useEffect(() => {
    loadState();
    return () => stopPolling();
  }, [loadState, stopPolling]);

  const startPlanning = async () => {
    setStarting(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`, { method: 'POST' });
      const data = await res.json();

      if (res.ok) {
        setState(prev => ({
          ...prev!,
          sessionKey: data.sessionKey,
          messages: data.messages || [],
          isStarted: true,
        }));
        startPolling();
      } else {
        setError(data.error || 'Failed to start planning');
      }
    } catch (err) {
      setError('Failed to start planning');
    } finally {
      setStarting(false);
    }
  };

  const submitAnswer = async () => {
    if (!selectedOption) return;

    setSubmitting(true);
    setIsSubmittingAnswer(true);
    setError(null);

    const submission = {
      answer: selectedOption === 'other' ? 'Other' : selectedOption,
      otherText: selectedOption === 'other' ? otherText : undefined,
    };
    lastSubmissionRef.current = submission;

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      });

      const data = await res.json();

      if (res.ok) {
        startPolling();
      } else {
        setError(data.error || 'Failed to submit answer');
        setIsSubmittingAnswer(false);
        setSelectedOption(null);
        setOtherText('');
      }
    } catch (err) {
      setError('Failed to submit answer');
      setIsSubmittingAnswer(false);
      setSelectedOption(null);
      setOtherText('');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetry = async () => {
    const submission = lastSubmissionRef.current;
    if (!submission) return;

    setSubmitting(true);
    setIsSubmittingAnswer(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
      });

      const data = await res.json();

      if (res.ok) {
        startPolling();
      } else {
        setError(data.error || 'Failed to submit answer');
        setIsSubmittingAnswer(false);
        setSelectedOption(null);
        setOtherText('');
      }
    } catch (err) {
      setError('Failed to submit answer');
      setIsSubmittingAnswer(false);
      setSelectedOption(null);
      setOtherText('');
    } finally {
      setSubmitting(false);
    }
  };

  const retryDispatch = async () => {
    setRetryingDispatch(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/retry-dispatch`, {
        method: 'POST',
      });

      const data = await res.json();

      if (res.ok) {
        console.log('Dispatch retry successful:', data.message);
        setError(null);
      } else {
        setError(`Failed to retry dispatch: ${data.error}`);
      }
    } catch (err) {
      setError('Failed to retry dispatch');
    } finally {
      setRetryingDispatch(false);
    }
  };

  const cancelPlanning = async () => {
    if (!confirm('Are you sure you want to cancel planning? This will reset the planning state.')) {
      return;
    }

    setCanceling(true);
    setError(null);
    setIsSubmittingAnswer(false);
    stopPolling();

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`, {
        method: 'DELETE',
      });

      if (res.ok) {
        setState({
          taskId,
          isStarted: false,
          messages: [],
          isComplete: false,
        });
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to cancel planning');
      }
    } catch (err) {
      setError('Failed to cancel planning');
    } finally {
      setCanceling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
        <span className="ml-2 text-gray-500">Loading planning state...</span>
      </div>
    );
  }

  if (state?.isComplete && state?.spec) {
    return (
      <div className="p-4 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-emerald-600">
            <Lock className="w-5 h-5" />
            <span className="font-medium">Planning Complete</span>
          </div>
          {state.dispatchError && (
            <div className="text-right">
              <span className="text-sm text-amber-600">Dispatch Failed</span>
            </div>
          )}
        </div>
        
        {state.dispatchError && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-amber-700 text-sm font-medium mb-2">Task dispatch failed</p>
                <p className="text-amber-600 text-xs mb-3">{state.dispatchError}</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={retryDispatch}
                    disabled={retryingDispatch}
                    className="px-3 py-1 bg-amber-100 hover:bg-amber-200 text-amber-700 text-xs rounded-lg disabled:opacity-50 flex items-center gap-1 transition-colors"
                  >
                    {retryingDispatch ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Retrying...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-3 h-3" />
                        Retry Dispatch
                      </>
                    )}
                  </button>
                  <span className="text-amber-600 text-xs">
                    This will attempt to assign the task to an agent
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <h3 className="font-medium text-gray-900 mb-2">{state.spec.title}</h3>
          <p className="text-sm text-gray-600 mb-4">{state.spec.summary}</p>
          
          {state.spec.deliverables?.length > 0 && (
            <div className="mb-3">
              <h4 className="text-sm font-medium text-gray-700 mb-1">Deliverables:</h4>
              <ul className="list-disc list-inside text-sm text-gray-600">
                {state.spec.deliverables.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          
          {state.spec.success_criteria?.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-1">Success Criteria:</h4>
              <ul className="list-disc list-inside text-sm text-gray-600">
                {state.spec.success_criteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        
        {state.agents && state.agents.length > 0 && (
          <div>
            <h3 className="font-medium text-gray-900 mb-2">Agents Created:</h3>
            <div className="space-y-2">
              {state.agents.map((agent, i) => (
                <div key={i} className="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center gap-3">
                  <span className="text-2xl">{agent.avatar_emoji}</span>
                  <div>
                    <p className="font-medium text-gray-900">{agent.name}</p>
                    <p className="text-sm text-gray-600">{agent.role}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!state?.isStarted) {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <div className="text-center">
          <h3 className="text-lg font-medium text-gray-900 mb-2">Start Planning</h3>
          <p className="text-gray-500 text-sm max-w-md">
            I&apos;ll ask you a few questions to understand exactly what you need. 
            All questions are multiple choice - just click to answer.
          </p>
        </div>
        
        {error && (
          <div className="flex items-center gap-2 text-red-600 text-sm">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}
        
        <button
          onClick={startPlanning}
          disabled={starting}
          className="px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2 transition-colors"
        >
          {starting ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Starting...
            </>
          ) : (
            <>Start Planning</>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-200 flex items-center justify-between bg-gray-50">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
          <span>Planning in progress...</span>
        </div>
        <button
          onClick={cancelPlanning}
          disabled={canceling}
          className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-50 font-medium transition-colors"
        >
          {canceling ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Canceling...
            </>
          ) : (
            <>
              <X className="w-4 h-4" />
              Cancel
            </>
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {state?.currentQuestion ? (
          <div className="max-w-xl mx-auto">
            <h3 className="text-lg font-medium text-gray-900 mb-6">
              {state.currentQuestion.question}
            </h3>

            <div className="space-y-3">
              {state.currentQuestion.options.map((option) => {
                const isSelected = selectedOption === option.label;
                const isOther = option.id === 'other' || option.label.toLowerCase() === 'other';
                const isThisOptionSubmitting = isSubmittingAnswer && isSelected;

                return (
                  <div key={option.id}>
                    <button
                      onClick={() => setSelectedOption(option.label)}
                      disabled={submitting}
                      className={`w-full flex items-center gap-3 p-4 rounded-lg border transition-all text-left ${
                        isThisOptionSubmitting
                          ? 'border-indigo-500 bg-indigo-100'
                          : isSelected
                          ? 'border-indigo-500 bg-indigo-50'
                          : 'border-gray-200 hover:border-indigo-300 bg-white'
                      } disabled:opacity-50`}
                    >
                      <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${
                        isSelected ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {option.id.toUpperCase()}
                      </span>
                      <span className="flex-1 text-gray-900">{option.label}</span>
                      {isThisOptionSubmitting ? (
                        <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
                      ) : isSelected && !submitting ? (
                        <CheckCircle className="w-5 h-5 text-indigo-600" />
                      ) : null}
                    </button>

                    {isOther && isSelected && (
                      <div className="mt-2 ml-11">
                        <input
                          type="text"
                          value={otherText}
                          onChange={(e) => setOtherText(e.target.value)}
                          placeholder="Please specify..."
                          className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                          disabled={submitting}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {error && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-red-600 text-sm">{error}</p>
                    {!isWaitingForResponse && lastSubmissionRef.current && (
                      <button
                        onClick={handleRetry}
                        disabled={submitting}
                        className="mt-2 text-xs text-red-600 hover:text-red-700 underline disabled:opacity-50"
                      >
                        {submitting ? 'Retrying...' : 'Retry'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="mt-6">
              <button
                onClick={submitAnswer}
                disabled={!selectedOption || submitting || (selectedOption === 'Other' && !otherText.trim())}
                className="w-full px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Sending...
                  </>
                ) : (
                  'Continue'
                )}
              </button>

              {isSubmittingAnswer && !submitting && (
                <div className="mt-4 flex items-center justify-center gap-2 text-sm text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
                  <span>Waiting for response...</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-600 mx-auto mb-2" />
              <p className="text-gray-500">
                {isWaitingForResponse ? 'Waiting for response...' : 'Waiting for next question...'}
              </p>
            </div>
          </div>
        )}
      </div>

      {state?.messages && state.messages.length > 0 && (
        <details className="border-t border-gray-200">
          <summary className="p-3 text-sm text-gray-500 cursor-pointer hover:bg-gray-50">
            View conversation ({state.messages.length} messages)
          </summary>
          <div className="p-3 space-y-2 max-h-48 overflow-y-auto bg-gray-50">
            {state.messages.map((msg, i) => (
              <div key={i} className={`text-sm ${msg.role === 'user' ? 'text-indigo-600' : 'text-gray-600'}`}>
                <span className="font-medium">{msg.role === 'user' ? 'You' : 'Orchestrator'}:</span>{' '}
                <span className="opacity-75">{msg.content.substring(0, 100)}...</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
