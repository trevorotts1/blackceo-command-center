'use client';

/**
 * DictateAnswerButton — SPEAK-your-answer affordance for the /interview surface.
 *
 * Restores the audio-or-text promise of the AI Workforce Interview: every
 * question can be answered by typing OR by voice. This is a thin, shared
 * wrapper around <MicDictateButton> (the Web Speech API dictation control the
 * task board already ships) that owns the interim-transcript merge so the two
 * interview consumers — the structured QuestionCard and the free-form
 * ConversationPane — never duplicate it:
 *
 *   • interim results REPLACE the previous interim chunk at the end of the
 *     field (live "what I'm hearing" feedback while the owner speaks);
 *   • the final result COMMITS in place of the interim chunk.
 *
 * The dictated text lands in the SAME controlled field the owner could have
 * typed into, and is submitted through the SAME write path
 * (/api/interview/answer or /api/interview/turn) — voice input never invents a
 * new persistence route, so every anti-fabrication/provenance gate is
 * inherited unchanged.
 *
 * Graceful degradation is inherited from MicDictateButton: browsers without
 * SpeechRecognition (e.g. Firefox) render a disabled mic with a tooltip; the
 * text path is always available. Chrome/Edge/Safari — including iOS Safari —
 * support dictation, so the phone experience keeps both modes.
 */

import { useRef } from 'react';
import { MicDictateButton } from '@/components/MicDictateButton';

export interface DictateAnswerButtonProps {
  /** The current value of the controlled field this button dictates into. */
  value: string;
  /** Setter for the controlled field (receives the merged text). */
  onChange: (next: string) => void;
  /** Disable while the field is submitting. */
  disabled?: boolean;
  /** Tooltip / aria label ("Speak your answer" by default). */
  label?: string;
  /** Extra classes for the underlying button. */
  className?: string;
}

/** Merge a dictation chunk onto the base text with a natural separator. */
function mergeChunk(base: string, chunk: string): string {
  const separator = base && !base.endsWith(' ') && !base.endsWith('\n') ? ' ' : '';
  return base + separator + chunk;
}

export default function DictateAnswerButton({
  value,
  onChange,
  disabled = false,
  label = 'Speak your answer',
  className = '',
}: DictateAnswerButtonProps) {
  // The in-flight interim chunk, so each new interim REPLACES the previous one
  // instead of stacking (same pattern the task board's dictation uses).
  const interimRef = useRef('');

  const handleTranscript = (text: string, isFinal: boolean) => {
    const prevInterim = interimRef.current;
    const base =
      prevInterim && value.endsWith(prevInterim)
        ? value.slice(0, value.length - prevInterim.length).replace(/[ ]$/, '')
        : value;
    interimRef.current = isFinal ? '' : text;
    onChange(mergeChunk(base, text));
  };

  return (
    <MicDictateButton
      label={label}
      disabled={disabled}
      onTranscript={handleTranscript}
      className={className}
    />
  );
}
