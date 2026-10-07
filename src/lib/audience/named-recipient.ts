/**
 * Pure helper: does the task itself say who it is going to?
 * "Send to Trevor Otts at trevorotts@blackceo.com" -> "Trevor Otts".
 * Conservative on purpose: unsure -> null (the board then asks the owner).
 */

const NAME = "[A-Z][a-z'’-]+(?:\\s+[A-Z][a-z'’-]+){0,2}";
const EMAIL = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}';

// Words that make a capitalised phrase a topic/platform, not a person.
const NOT_A_PERSON = new Set([
  'social', 'media', 'marketing', 'email', 'campaign', 'campaigns', 'newsletter', 'blog', 'post', 'posts',
  'instagram', 'facebook', 'linkedin', 'twitter', 'tiktok', 'youtube', 'pinterest', 'threads', 'google',
  'business', 'customers', 'clients', 'team', 'audience', 'followers', 'subscribers', 'event', 'events',
  'launch', 'sale', 'promo', 'website', 'page', 'funnel', 'podcast', 'week', 'month', 'monday', 'tuesday',
  'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may',
  'june', 'july', 'august', 'september', 'october', 'november', 'december', 'the', 'my', 'our', 'your',
]);

const clean = (s: string) => s.replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
const looksLikePerson = (n: string) => n.split(/\s+/).every((w) => !NOT_A_PERSON.has(w.toLowerCase()));

export function extractNamedRecipient(title: string | null | undefined, description?: string | null): string | null {
  const text = clean(`${title ?? ''}. ${description ?? ''}`);
  if (!text) return null;

  // 1. "send (it|this|an email) to Name" - a single first name is enough here.
  const sendTo = text.match(new RegExp(`\\b[Ss]end(?:\\s+(?:it|this|that|an?\\s+[a-z-]+(?:\\s+[a-z-]+)?))?\\s+to\\s+(${NAME})`));
  if (sendTo && looksLikePerson(sendTo[1])) return sendTo[1];

  // 2. "to Name at someone@x.com"
  const toAt = text.match(new RegExp(`\\bto\\s+(${NAME})\\s+at\\s+${EMAIL}`));
  if (toAt && looksLikePerson(toAt[1])) return toAt[1];

  // 3. "email/message/text/DM/ping/for First Last" - require 2+ words (a lone capitalised word is too often a topic).
  const direct = text.match(new RegExp(`\\b(?:[Ee]-?mail|[Mm]essage|[Tt]ext|DM|[Pp]ing|for)\\s+(${NAME})`));
  if (direct && direct[1].includes(' ') && looksLikePerson(direct[1])) return direct[1];

  // 4. A bare email address that is clearly the recipient.
  const mail = text.match(new RegExp(`\\b(?:send|sent|to|forward|cc|reply)\\b[^.\\n]{0,40}?(${EMAIL})`, 'i'));
  if (mail) return mail[1];

  return null;
}
