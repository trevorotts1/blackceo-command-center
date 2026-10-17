import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const roomCss = readFileSync(join(root, 'src/components/council/council-room.css'), 'utf8');
const themeCss = readFileSync(join(root, 'src/components/council/council-theme.css'), 'utf8');
const roomComponent = readFileSync(join(root, 'src/components/council/CouncilRoom.tsx'), 'utf8');

test('phone Council stage uses fluid padding instead of fixed 24px per side', () => {
  assert.ok(roomComponent.includes("padding: 'clamp(0.75rem, 2.5vw, 1.5rem)'"));
});

test('narrow Council room keeps two shrinkable tracks and no absolute seat positions', () => {
  assert.match(roomCss, /@container \(max-width: 640px\)/);
  assert.match(roomCss, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(roomCss, /\.council-room-frame \.council-room-seat \{[\s\S]*?position: static/);
  assert.match(roomCss, /\.council-room-frame \.council-room-seat \{[\s\S]*?min-width: 0/);
  assert.match(roomCss, /\.council-theme \.council-room-center-decision \{[\s\S]*?overflow-wrap: anywhere/);
});

test('Council mobile drawer remains scrollable, contains long hashes and respects safe areas', () => {
  assert.match(roomCss, /\.council-theme \.council-drawer \{[\s\S]*?overflow-wrap: anywhere/);
  assert.match(roomCss, /env\(safe-area-inset-bottom\)/);
  assert.match(roomCss, /env\(safe-area-inset-left\)/);
  assert.match(roomCss, /env\(safe-area-inset-right\)/);
  assert.match(roomCss, /@media \(max-width: 420px\)/);
});

test('Council retains large text, accessible control targets and no global style mutations', () => {
  assert.ok(themeCss.includes('--council-text-name: 1rem;'));
  assert.ok(themeCss.includes('--council-touch-target: 44px;'));
  assert.ok(!/(^|\n)\s*:root\s*\{/.test(roomCss));
  assert.ok(!/(^|\n)\s*--bcc-/.test(roomCss));
  assert.ok(!roomCss.includes('!important'), 'room CSS should not override unrelated themes');
});
