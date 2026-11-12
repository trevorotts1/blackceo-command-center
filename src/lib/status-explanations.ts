/**
 * Plain-English explanations for every status row the owner can open from the
 * header. Each answers the same three questions: what does this mean, do I
 * need to do anything, and what is the concrete next step. No probe jargon,
 * no raw error strings (the raw string stays in the row's own detail).
 *
 * Pure data, no imports of server code, so the client drawer can use it.
 */
export interface StatusExplanation {
  meaning: string;
  /** True when the owner has to act; false when it is safe to ignore. */
  actionNeeded: boolean;
  nextStep: string;
  link?: { label: string; href: string };
}

const PROVIDER_NAMES: Record<string, { name: string; models: string }> = {
  provider_anthropic: { name: 'Anthropic', models: 'Claude models' },
  provider_openai: { name: 'OpenAI', models: 'GPT models' },
  provider_google: { name: 'Google', models: 'Gemini models' },
  provider_moonshot: { name: 'Moonshot', models: 'Kimi models' },
  provider_minimax: { name: 'MiniMax', models: 'MiniMax models' },
  provider_zai: { name: 'Z.ai', models: 'GLM models' },
  provider_openrouter: { name: 'OpenRouter', models: 'models routed through OpenRouter' },
  provider_ollama_cloud: { name: 'Ollama Cloud', models: 'Ollama Cloud models' },
  provider_kieai: { name: 'KIE', models: 'image, video and audio generation' },
  provider_falai: { name: 'fal.ai', models: 'fal.ai image and video generation' },
};

const isProblem = (status: string) => status !== 'live' && status !== 'working';

function providerExplanation(component: string, status: string, error?: string): StatusExplanation {
  const p = PROVIDER_NAMES[component] ?? { name: 'This AI provider', models: 'its models' };
  if (/auth rejected/i.test(error ?? '') || status === 'degraded' && /401|403/.test(error ?? '')) {
    return {
      meaning: `Your ${p.name} key was rejected, so ${p.models} cannot be used right now. Everything else keeps working.`,
      actionNeeded: false,
      nextStep: `If you do not use ${p.models}, you can ignore this. If you do, ask your support team to replace the ${p.name} key.`,
    };
  }
  if (status === 'busy') {
    return {
      meaning: `${p.name} is asking us to slow down for a moment, so ${p.models} may respond slowly.`,
      actionNeeded: false,
      nextStep: 'Nothing to do. This clears by itself, usually within a few minutes.',
    };
  }
  return {
    meaning: `We could not reach ${p.name} just now, so ${p.models} may be unavailable. Your other tools are not affected.`,
    actionNeeded: false,
    nextStep: `Usually this clears by itself. If it is still showing after an hour and you use ${p.models}, tell your support team.`,
  };
}

export function explainStatus(row: { component: string; status: string; error?: string; tier?: string }): StatusExplanation | null {
  if (!isProblem(row.status)) return null;
  const { component, status, error } = row;
  if (component.startsWith('provider_')) return providerExplanation(component, status, error);
  switch (component) {
    case 'cloudflare_access':
      return {
        meaning: 'This checks the secure sign-in that protects your dashboard. It has not seen anyone come in through that sign-in in the last few minutes while requests were arriving.',
        actionNeeded: false,
        nextStep: 'If you can open this dashboard normally, you can ignore it. If you cannot sign in, tell your support team.',
      };
    case 'cloudflare_tunnel':
      return {
        meaning: 'The private connection that lets you reach this dashboard from the internet looks unhealthy.',
        actionNeeded: status === 'offline',
        nextStep: 'If you can read this page, the connection is working and you can ignore it. If the dashboard stops loading on your phone or another computer, tell your support team.',
      };
    case 'openclaw_gateway':
      return {
        meaning: 'The link between this dashboard and your AI team is down, so your assistants cannot receive new work from here until it comes back.',
        actionNeeded: true,
        nextStep: 'It reconnects on its own. If it is still showing after a few minutes, tell your support team.',
      };
    case 'database':
      return {
        meaning: 'The place where this dashboard keeps your tasks and history is not responding.',
        actionNeeded: true,
        nextStep: 'Please tell your support team right away. Do not try to fix this yourself.',
      };
    case 'telegram':
      return {
        meaning: 'Messages to your Telegram chat may not be going through.',
        actionNeeded: false,
        nextStep: 'Your assistants still work. If you stop receiving their messages, tell your support team.',
      };
    case 'disk':
      return {
        meaning: 'The computer this dashboard runs on is running low on storage space.',
        actionNeeded: true,
        nextStep: 'Tell your support team so they can free up space before it fills up.',
      };
    case 'memory':
    case 'embedding_readiness':
      return {
        meaning: 'Your assistants’ long-term memory search is not fully ready, so they may remember less than usual for a while.',
        actionNeeded: false,
        nextStep: 'It usually finishes on its own. If it is still showing tomorrow, tell your support team.',
      };
    case 'jobs':
      return {
        meaning: 'Some scheduled background jobs did not run on time.',
        actionNeeded: false,
        nextStep: 'They catch up on their own. If it keeps showing for a day, tell your support team.',
      };
    case 'agents':
      return {
        meaning: 'Some of your AI team members are not reporting in.',
        actionNeeded: false,
        nextStep: 'They are usually just idle or restarting. If a specific assistant stops answering, tell your support team.',
      };
    case 'cli':
      return {
        meaning: 'A helper tool this dashboard uses behind the scenes is not responding.',
        actionNeeded: false,
        nextStep: 'Nothing to do unless something you asked for does not finish. Then tell your support team.',
      };
    case 'live_feed':
      return {
        meaning: 'The live activity feed is not updating right now.',
        actionNeeded: false,
        nextStep: 'Refresh the page. Your tasks and assistants are not affected.',
      };
    case 'unauthorized_401':
      return {
        meaning: 'Some sign-in attempts to this dashboard were turned away recently.',
        actionNeeded: false,
        nextStep: 'If that was you, sign in again from your private link. Otherwise nothing to do.',
      };
    default:
      return {
        meaning: 'One of the background checks on this dashboard is not reporting a clean result.',
        actionNeeded: false,
        nextStep: 'If everything you use is working, you can ignore it. If not, tell your support team.',
      };
  }
}
