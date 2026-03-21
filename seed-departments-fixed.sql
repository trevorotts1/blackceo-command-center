-- Mission Control Task Redistribution Script - Part 2: New Tasks
-- Using valid status: pending_dispatch, planning, inbox, assigned, in_progress, testing, review, done
-- Using valid priority: low, normal, high, urgent

-- CEO Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('ceo-task-01', 'Define quarterly vision', 'Outline strategic priorities for Q2', 'done', 'high', 'ceo', 'ceo', datetime('now'), datetime('now')),
('ceo-task-02', 'Approve marketing budget', 'Review and approve Q2 marketing spend', 'in_progress', 'urgent', 'ceo', 'ceo', datetime('now'), datetime('now')),
('ceo-task-03', 'Board meeting prep', 'Prepare slides for quarterly board review', 'assigned', 'high', 'ceo', 'ceo', datetime('now'), datetime('now'));

-- Marketing Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('mkt-task-01', 'Launch email campaign', 'Q2 product launch email sequence', 'in_progress', 'high', 'marketing', 'marketing', datetime('now'), datetime('now')),
('mkt-task-02', 'Update brand guidelines', 'Refresh logo usage and color palette docs', 'inbox', 'normal', 'marketing', 'marketing', datetime('now'), datetime('now')),
('mkt-task-03', 'SEO audit', 'Technical SEO review of main site', 'testing', 'normal', 'marketing', 'marketing', datetime('now'), datetime('now')),
('mkt-task-04', 'Social media calendar', 'Plan content for next month', 'assigned', 'normal', 'marketing', 'marketing', datetime('now'), datetime('now'));

-- Sales Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('sales-task-01', 'Follow up leads', 'Contact 50 warm leads from webinar', 'in_progress', 'high', 'sales', 'sales', datetime('now'), datetime('now')),
('sales-task-02', 'Update CRM', 'Clean up duplicate contacts', 'inbox', 'low', 'sales', 'sales', datetime('now'), datetime('now')),
('sales-task-03', 'Sales deck refresh', 'Update pricing slides', 'assigned', 'normal', 'sales', 'sales', datetime('now'), datetime('now')),
('sales-task-04', 'Demo preparation', 'Prepare custom demo for enterprise client', 'in_progress', 'urgent', 'sales', 'sales', datetime('now'), datetime('now'));

-- Billing Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('bill-task-01', 'Monthly reconciliation', 'Reconcile all March transactions', 'done', 'high', 'billing', 'billing', datetime('now'), datetime('now')),
('bill-task-02', 'Invoice overdue clients', 'Send reminders to 30+ day accounts', 'in_progress', 'urgent', 'billing', 'billing', datetime('now'), datetime('now')),
('bill-task-03', 'Tax preparation', 'Gather docs for quarterly filing', 'assigned', 'high', 'billing', 'billing', datetime('now'), datetime('now'));

-- Support Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('sup-task-01', 'Ticket backlog cleanup', 'Resolve tickets older than 14 days', 'in_progress', 'high', 'support', 'support', datetime('now'), datetime('now')),
('sup-task-02', 'Update knowledge base', 'Add FAQ for new feature', 'inbox', 'normal', 'support', 'support', datetime('now'), datetime('now')),
('sup-task-03', 'VIP escalation', 'Handle enterprise customer issue', 'assigned', 'urgent', 'support', 'support', datetime('now'), datetime('now'));

-- Operations Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('ops-task-01', 'Vendor contract review', 'Renegotiate hosting agreement', 'in_progress', 'normal', 'operations', 'operations', datetime('now'), datetime('now')),
('ops-task-02', 'Office supply inventory', 'Restock kitchen and supplies', 'inbox', 'low', 'operations', 'operations', datetime('now'), datetime('now')),
('ops-task-03', 'Security audit', 'Review access logs and permissions', 'assigned', 'high', 'operations', 'operations', datetime('now'), datetime('now'));

-- Creative Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('cre-task-01', 'Landing page design', 'New product launch landing page', 'in_progress', 'high', 'creative', 'creative', datetime('now'), datetime('now')),
('cre-task-02', 'Brand refresh concepts', 'Explore new visual direction', 'inbox', 'normal', 'creative', 'creative', datetime('now'), datetime('now')),
('cre-task-03', 'Social assets', 'Create Instagram carousel templates', 'testing', 'normal', 'creative', 'creative', datetime('now'), datetime('now')),
('cre-task-04', 'Presentation deck', 'Design keynote for CEO all-hands', 'assigned', 'high', 'creative', 'creative', datetime('now'), datetime('now'));

-- HR Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('hr-task-01', 'Job postings', 'Write JD for senior developer role', 'in_progress', 'high', 'hr', 'hr', datetime('now'), datetime('now')),
('hr-task-02', 'Onboarding docs', 'Update new hire checklist', 'done', 'normal', 'hr', 'hr', datetime('now'), datetime('now')),
('hr-task-03', 'Performance reviews', 'Schedule Q1 review meetings', 'assigned', 'normal', 'hr', 'hr', datetime('now'), datetime('now'));

-- Legal Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('legal-task-01', 'Contract review', 'Review partnership agreement', 'in_progress', 'high', 'legal', 'legal', datetime('now'), datetime('now')),
('legal-task-02', 'Privacy policy update', 'Update for new regulations', 'inbox', 'normal', 'legal', 'legal', datetime('now'), datetime('now')),
('legal-task-03', 'Trademark filing', 'Submit application for new product name', 'assigned', 'urgent', 'legal', 'legal', datetime('now'), datetime('now'));

-- IT Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('it-task-01', 'Server maintenance', 'Apply security patches', 'in_progress', 'urgent', 'it', 'it', datetime('now'), datetime('now')),
('it-task-02', 'VPN setup', 'Configure new team member access', 'done', 'normal', 'it', 'it', datetime('now'), datetime('now')),
('it-task-03', 'Backup verification', 'Test disaster recovery procedures', 'assigned', 'high', 'it', 'it', datetime('now'), datetime('now'));

-- WebDev Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('web-task-01', 'Homepage redesign', 'Implement new hero section', 'in_progress', 'high', 'webdev', 'webdev', datetime('now'), datetime('now')),
('web-task-02', 'Performance optimization', 'Improve Core Web Vitals scores', 'testing', 'normal', 'webdev', 'webdev', datetime('now'), datetime('now')),
('web-task-03', 'Bug fixes', 'Fix mobile navigation issues', 'inbox', 'normal', 'webdev', 'webdev', datetime('now'), datetime('now')),
('web-task-04', 'Analytics integration', 'Add conversion tracking events', 'assigned', 'high', 'webdev', 'webdev', datetime('now'), datetime('now'));

-- AppDev Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('app-task-01', 'Push notifications', 'Implement FCM integration', 'in_progress', 'high', 'appdev', 'appdev', datetime('now'), datetime('now')),
('app-task-02', 'iOS build', 'Submit v2.1 to App Store', 'testing', 'urgent', 'appdev', 'appdev', datetime('now'), datetime('now')),
('app-task-03', 'Crash analytics', 'Integrate Sentry error tracking', 'inbox', 'normal', 'appdev', 'appdev', datetime('now'), datetime('now'));

-- Graphics Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('gfx-task-01', 'Logo variations', 'Create monochrome and reversed versions', 'done', 'normal', 'graphics', 'graphics', datetime('now'), datetime('now')),
('gfx-task-02', 'Icon set', 'Design 24 app icons', 'in_progress', 'high', 'graphics', 'graphics', datetime('now'), datetime('now')),
('gfx-task-03', 'Illustrations', 'Create hero illustrations for blog', 'assigned', 'normal', 'graphics', 'graphics', datetime('now'), datetime('now'));

-- Video Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('vid-task-01', 'Product demo video', 'Record feature walkthrough', 'in_progress', 'high', 'video', 'video', datetime('now'), datetime('now')),
('vid-task-02', 'Testimonial edits', 'Cut customer interview footage', 'inbox', 'normal', 'video', 'video', datetime('now'), datetime('now')),
('vid-task-03', 'Social clips', 'Create 15-second promo shorts', 'testing', 'normal', 'video', 'video', datetime('now'), datetime('now')),
('vid-task-04', 'YouTube thumbnail', 'Design for latest upload', 'assigned', 'low', 'video', 'video', datetime('now'), datetime('now'));

-- Audio Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('aud-task-01', 'Podcast editing', 'Edit episode 48', 'in_progress', 'high', 'audio', 'audio', datetime('now'), datetime('now')),
('aud-task-02', 'Background music', 'Compose for product video', 'inbox', 'normal', 'audio', 'audio', datetime('now'), datetime('now')),
('aud-task-03', 'Voice over', 'Record VO for tutorial', 'assigned', 'normal', 'audio', 'audio', datetime('now'), datetime('now'));

-- Research Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('res-task-01', 'Market analysis', 'Competitor feature comparison', 'in_progress', 'high', 'research', 'research', datetime('now'), datetime('now')),
('res-task-02', 'User interviews', 'Schedule and conduct 10 sessions', 'assigned', 'normal', 'research', 'research', datetime('now'), datetime('now')),
('res-task-03', 'Trend report', 'Compile emerging tech trends Q2', 'inbox', 'normal', 'research', 'research', datetime('now'), datetime('now'));

-- Comms Tasks
INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at) VALUES
('com-task-01', 'Press release', 'Draft product launch announcement', 'in_progress', 'high', 'comms', 'comms', datetime('now'), datetime('now')),
('com-task-02', 'Media kit', 'Update company fact sheet', 'done', 'normal', 'comms', 'comms', datetime('now'), datetime('now')),
('com-task-03', 'Crisis protocol', 'Review and update response plan', 'assigned', 'urgent', 'comms', 'comms', datetime('now'), datetime('now'));

-- ============================================
-- EVENTS FOR LIVE FEED
-- ============================================

INSERT INTO events (id, type, task_id, message, created_at) VALUES
('evt-001', 'task_created', 'ceo-task-01', 'Task completed: Define quarterly vision', datetime('now')),
('evt-002', 'task_updated', 'ceo-task-02', 'Task moved to in_progress: Approve marketing budget', datetime('now')),
('evt-003', 'task_created', 'mkt-task-01', 'New task created: Launch email campaign', datetime('now')),
('evt-004', 'task_created', 'mkt-task-02', 'New task created: Update brand guidelines', datetime('now')),
('evt-005', 'task_updated', 'sales-task-01', 'Task moved to in_progress: Follow up leads', datetime('now')),
('evt-006', 'task_created', 'sales-task-04', 'New urgent task: Demo preparation', datetime('now')),
('evt-007', 'task_updated', 'bill-task-01', 'Task completed: Monthly reconciliation', datetime('now')),
('evt-008', 'task_created', 'bill-task-02', 'New urgent task: Invoice overdue clients', datetime('now')),
('evt-009', 'task_created', 'sup-task-01', 'New task created: Ticket backlog cleanup', datetime('now')),
('evt-010', 'task_created', 'sup-task-03', 'New urgent task: VIP escalation', datetime('now')),
('evt-011', 'task_created', 'ops-task-01', 'New task created: Vendor contract review', datetime('now')),
('evt-012', 'task_updated', 'cre-task-01', 'Task moved to in_progress: Landing page design', datetime('now')),
('evt-013', 'task_created', 'cre-task-04', 'New task created: Presentation deck', datetime('now')),
('evt-014', 'task_updated', 'hr-task-02', 'Task completed: Onboarding docs', datetime('now')),
('evt-015', 'task_created', 'hr-task-01', 'New task created: Job postings', datetime('now')),
('evt-016', 'task_created', 'legal-task-03', 'New urgent task: Trademark filing', datetime('now')),
('evt-017', 'task_updated', 'it-task-01', 'Task moved to in_progress: Server maintenance', datetime('now')),
('evt-018', 'task_created', 'it-task-03', 'New task created: Backup verification', datetime('now')),
('evt-019', 'task_updated', 'web-task-01', 'Task moved to in_progress: Homepage redesign', datetime('now')),
('evt-020', 'task_created', 'web-task-04', 'New task created: Analytics integration', datetime('now')),
('evt-021', 'task_updated', 'app-task-01', 'Task moved to in_progress: Push notifications', datetime('now')),
('evt-022', 'task_updated', 'app-task-02', 'Task moved to testing: iOS build', datetime('now')),
('evt-023', 'task_updated', 'gfx-task-01', 'Task completed: Logo variations', datetime('now')),
('evt-024', 'task_created', 'gfx-task-02', 'New task created: Icon set', datetime('now')),
('evt-025', 'task_created', 'vid-task-01', 'New task created: Product demo video', datetime('now')),
('evt-026', 'task_created', 'vid-task-04', 'New task created: YouTube thumbnail', datetime('now')),
('evt-027', 'task_updated', 'aud-task-01', 'Task moved to in_progress: Podcast editing', datetime('now')),
('evt-028', 'task_created', 'aud-task-03', 'New task created: Voice over', datetime('now')),
('evt-029', 'task_updated', 'res-task-01', 'Task moved to in_progress: Market analysis', datetime('now')),
('evt-030', 'task_created', 'res-task-02', 'New task created: User interviews', datetime('now')),
('evt-031', 'task_updated', 'com-task-02', 'Task completed: Media kit', datetime('now')),
('evt-032', 'task_created', 'com-task-03', 'New urgent task: Crisis protocol', datetime('now'));
