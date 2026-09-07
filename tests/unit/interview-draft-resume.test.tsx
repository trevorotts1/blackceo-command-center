import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuestionCard from '@/components/interview/QuestionCard';
import type { InterviewQuestion } from '@/lib/interview-questions';

const question = {id:'company_name',prompt:'What is your company name?',section:'identity',kind:'text',required:true} as InterviewQuestion;
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('real interview card pause and resume', () => {
  it('restores an unfinished answer on this browser without submitting it', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch',fetcher);
    const view = render(<QuestionCard question={question} draftScope="client-a-install-one-interview-one" onAnswered={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'My unfinished company answer'}});
    view.unmount();
    render(<QuestionCard question={question} draftScope="client-a-install-one-interview-one" onAnswered={vi.fn()} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('My unfinished company answer');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never restores another client or interview draft', () => {
    const view = render(<QuestionCard question={question} draftScope="client-a" onAnswered={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Private client A answer'}});
    view.unmount();
    render(<QuestionCard question={question} draftScope="client-b" onAnswered={vi.fn()} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });
  it('keeps failed-save text, clears draft only after server acceptance', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({ok:true,appended:true}));
    vi.stubGlobal('fetch', fetcher);
    const saved = vi.fn();
    render(<QuestionCard question={question} draftScope="client-a" onAnswered={saved} />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Company answer'}});
    fireEvent.click(screen.getByRole('button',{name:'Continue'}));
    await screen.findByRole('alert');
    expect(saved).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(1);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Company answer');
    fireEvent.click(screen.getByRole('button',{name:'Continue'}));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(localStorage.length).toBe(0);
  });
  it('explains how to renew expired sign-in and keeps the unfinished answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({error:'unauthorized'}, {status:403})));
    const saved = vi.fn();
    render(<QuestionCard question={question} draftScope="client-a" onAnswered={saved} />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Keep this answer'}});
    fireEvent.click(screen.getByRole('button',{name:'Continue'}));
    expect((await screen.findByRole('alert')).textContent).toContain('resume my interview');
    expect(saved).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(1);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Keep this answer');
  });
  it('continues working when browser storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype,'setItem').mockImplementation(() => {throw new Error('unavailable');});
    render(<QuestionCard question={question} draftScope="client-a" onAnswered={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Still editable'}});
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Still editable');
    spy.mockRestore();
  });
});
