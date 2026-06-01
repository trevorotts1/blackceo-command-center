/**
 * App-wide walkthrough decks (B3).
 *
 * Generalizes the Operator-Console-only onboarding (OperatorOnboarding.tsx +
 * onboarding-content.ts) into per-route card decks for the whole app. Each deck
 * is keyed by a route prefix; AppWalkthrough picks the deck for the current
 * pathname and runs it as an INTERACTIVE tour: as each card explains a feature
 * the overlay navigates to that route and scrolls/highlights the on-screen
 * element named by `target` (a `[data-walkthrough="..."]` anchor).
 *
 * Copy style matches onboarding-content.ts: plain-English, beginner-friendly.
 * Kept as data (not JSX) so copy stays editable without touching components.
 */

export interface WalkthroughCard {
  /** Stable id. */
  id: string;
  /** Card title. */
  title: string;
  /** One-line summary under the title. */
  summary: string;
  /** Plain-English body. */
  body: string;
  /** Accent color. */
  accent: string;
  /**
   * Optional route to navigate to when this card is shown (interactive).
   * Defaults to the deck's route if omitted.
   */
  route?: string;
  /**
   * Optional `[data-walkthrough]` anchor name to scroll to + highlight when
   * this card is shown. The overlay dims and outlines the element so the user
   * sees exactly what the card is talking about.
   */
  target?: string;
}

export interface WalkthroughDeck {
  /** Stable deck id (also the localStorage "seen" key suffix). */
  id: string;
  /** Route prefix this deck belongs to (longest match wins). */
  routePrefix: string;
  /** Human label (e.g. for a "?" button). */
  label: string;
  cards: WalkthroughCard[];
}

/**
 * Kanban / Mission Queue deck. Route: /tasks/all (the real board; /kanban
 * 308-redirects here).
 */
const KANBAN_DECK: WalkthroughDeck = {
  id: 'kanban',
  routePrefix: '/tasks',
  label: 'Kanban walkthrough',
  cards: [
    {
      id: 'overview',
      title: 'Your Mission Queue',
      summary: 'Every piece of work lives here as a card.',
      body: 'This board shows all your tasks as cards. Each card moves left-to-right across the columns as the work gets done. You drive it by dragging cards, and your AI agents move them automatically as they finish.',
      accent: '#43A047',
      route: '/tasks/all',
    },
    {
      id: 'new-task',
      title: 'Start a new task',
      summary: 'The "New Task" button adds work to the board.',
      body: 'Click here to add a task. Just a title and a short description is enough — the Command Center will pick the right playbook (SOP) and route it to the right department and agent for you.',
      accent: '#2563EB',
      route: '/tasks/all',
      target: 'new-task',
    },
    {
      id: 'columns',
      title: 'The six columns',
      summary: 'Backlog → To-Do → In Progress → Review → Done.',
      body: 'Work flows left to right: Backlog (just landed), To-Do (groomed and ready), In Progress (an agent is on it), Review / QC (finished, awaiting your check), Blocked (stuck), and Done. A card in "In Progress" is being actively worked by an agent right now.',
      accent: '#F59E0B',
      route: '/tasks/all',
      target: 'column-in_progress',
    },
    {
      id: 'auto-move',
      title: 'Cards move on their own',
      summary: 'When an agent finishes, the card advances instantly.',
      body: 'You do not have to move finished work yourself. The moment an agent reports a task complete, its card jumps to Review / QC automatically — no refresh needed. You only step in to approve it into Done.',
      accent: '#10B981',
      route: '/tasks/all',
      target: 'column-review',
    },
    {
      id: 'triad',
      title: 'The Triad Rule',
      summary: 'A task needs three things to leave Backlog.',
      body: 'Before a card can start, it needs a real description, a matching SOP (playbook), and a persona (the expert style the agent should use). The Command Center fills these in automatically from your starter SOP library, so most tasks are ready to go on their own.',
      accent: '#8B5CF6',
      route: '/tasks/all',
      target: 'column-backlog',
    },
    {
      id: 'pills',
      title: 'The 🧠 and 🤖 pills',
      summary: 'See the persona and the intended model at a glance.',
      body: 'On each card, the 🧠 pill shows the persona (expert style) chosen for it, and the 🤖 pill shows the model the Command Center intends to run it on. Click a pill to dig into the details.',
      accent: '#EC4899',
      route: '/tasks/all',
      target: 'filters',
    },
  ],
};

export const WALKTHROUGH_DECKS: WalkthroughDeck[] = [KANBAN_DECK];

/**
 * Pick the deck whose routePrefix is the longest match for the given pathname.
 * Returns undefined if no deck applies to this route.
 */
export function getDeckForPath(pathname: string): WalkthroughDeck | undefined {
  let best: WalkthroughDeck | undefined;
  for (const deck of WALKTHROUGH_DECKS) {
    if (pathname.startsWith(deck.routePrefix)) {
      if (!best || deck.routePrefix.length > best.routePrefix.length) best = deck;
    }
  }
  return best;
}

/** Look up a deck by its id. */
export function getDeckById(id: string): WalkthroughDeck | undefined {
  return WALKTHROUGH_DECKS.find((d) => d.id === id);
}

export const WALKTHROUGH_OPEN_EVENT = 'bcc:app-walkthrough';
export const walkthroughSeenKey = (deckId: string) => `bcc-${deckId}-walkthrough-seen`;
