'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('Status viewer exposes keyboard, focus, timing, and reduced-motion controls', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

  assert.match(html, /id="story-viewer"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="story-viewer-name"/);
  assert.match(html, /<button[^>]*id="story-save"[^>]*type="button"/,
    'the dynamic Save action remains keyboard-focusable when shown');
  assert.match(html, /<button[^>]*id="story-pause"[^>]*aria-label="Pause status playback"/,
    'timed Status content has an explicit pause control');
  assert.match(source, /storyViewerReturnFocus = document\.activeElement;/);
  assert.match(source, /returnFocus\?\.isConnected[\s\S]{0,100}?returnFocus\.focus\(\)/,
    'closing the modal viewer restores the invoking control');
  assert.match(source, /prefers-reduced-motion: reduce/,
    'Status auto-advance starts paused for reduced-motion users');
  assert.match(source, /storyViewerOpen && e\.key === 'Tab'[\s\S]{0,900}?last\.focus\(\)/,
    'keyboard focus is trapped within the modal viewer');
  assert.match(source, /storyViewerOpen && e\.key === 'ArrowLeft'/);
  assert.match(source, /storyViewerOpen && e\.key === 'ArrowRight'/);
  assert.match(source, /storySequence\[storyIndex\]\?\.kind === 'ad'[\s\S]{0,180}?Sponsored story/,
    'navigation cannot bypass the required 30-second sponsored Status');
});
