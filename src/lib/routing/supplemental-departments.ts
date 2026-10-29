import type { DepartmentConfig } from './departments.config';

/**
 * Hint seeds for departments that are routable but are NOT part of the
 * 26-department floor: they enrich a client workspace of that name (same as
 * DEFAULT_DEPARTMENTS) and never join the fallback floor, so no department
 * count, canonical set or doc figure changes. They live in their own file
 * because qc-cc.sh check 2.5 counts the department ids in departments.config.ts
 * and that file must define exactly the 26. Matching is substring-based
 * (keywordScore), so keep entries to phrases that cannot occur by accident:
 * no bare 'ap', 'ar' or 'je'.
 */
export const SUPPLEMENTAL_DEPARTMENT_HINTS: DepartmentConfig[] = [
  {
    id: 'accounting',
    name: 'Accounting',
    purpose:
      'Bookkeeping and the books: bank feed entries, journal entries, reconciliations, chart of accounts, payroll journal entries, QuickBooks Online cleanup, Bill.com bills, accounts payable entries, financial statements, audits of the books and Form 990 prep.',
    keywords: [
      'accounting',
      'bookkeep',
      'quickbooks',
      'qbo',
      'bank feed',
      'bank-feed',
      'bank transaction',
      'journal entry',
      'journal entries',
      'reconcil',
      'chart of accounts',
      'general ledger',
      'trial balance',
      'payroll je',
      'payroll journal',
      'bill.com',
      'accounts payable',
      'duplicate transaction',
      'duplicate cleanup',
      'financial statement',
      'audit of the books',
      'form 990',
      '990s',
    ],
    agentRoles: ['Accountant', 'Bookkeeper', 'Accounts Payable', 'Controller'],
    priority: 8,
  },
];
