import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/visitor-viewport.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { measureVisitorViewport: measure, INITIAL_VISITOR_VIEWPORT: initial } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const mobile = { isMobile: true, layoutWidth: 390, layoutHeight: 800, visualHeight: 800, visualTop: 0, scale: 1, focused: false };

test('Initial SSR snapshot does not depend on a browser or override CSS', () => {
  assert.equal(initial.style, undefined);
  assert.equal(initial.isKeyboardOpen, false);
});

test('Focused software keyboard shrinks the shell and tracks viewport panning', () => {
  const ready = measure(initial, mobile);
  const typing = measure(ready, { ...mobile, visualHeight: 470, visualTop: 24, focused: true });
  assert.deepEqual(typing.style, { '--visitor-height': '470px', '--visitor-top': '24px' });
  assert.equal(typing.isKeyboardOpen, true);
  const panned = measure(typing, { ...mobile, visualHeight: 470, visualTop: 52, focused: true });
  assert.equal(panned.style['--visitor-top'], '52px');
});

test('Address-bar changes and focus without a keyboard do not collapse the portrait', () => {
  const ready = measure(initial, mobile);
  for (const focused of [false, true]) {
    const chrome = measure(ready, { ...mobile, visualHeight: 730, focused });
    assert.equal(chrome.style['--visitor-height'], '730px');
    assert.equal(chrome.isKeyboardOpen, false);
  }
  assert.equal(measure(ready, { ...mobile, focused: true }).isKeyboardOpen, false);
  assert.equal(measure(ready, { ...mobile, visualHeight: 450, focused: false }).isKeyboardOpen, false);
});

test('Pinch zoom and panning preserve layout and never imply a keyboard', () => {
  const ready = measure(initial, mobile);
  const zoomed = measure(ready, { ...mobile, visualHeight: 400, visualTop: 120, scale: 2, focused: true });
  assert.equal(zoomed, ready);
  assert.equal(zoomed.isKeyboardOpen, false);
  assert.equal(measure(initial, { ...mobile, scale: 2, visualHeight: 400 }).style, undefined);
  assert.equal(measure(zoomed, { ...mobile, focused: true }).style['--visitor-height'], '800px');
});

test('Zooming with a real keyboard already open does not trigger another layout change', () => {
  const typing = measure(measure(initial, mobile), { ...mobile, visualHeight: 470, focused: true });
  assert.equal(measure(typing, { ...mobile, visualHeight: 235, scale: 2, focused: true }), typing);
  const blurred = measure(typing, { ...mobile, visualHeight: 235, scale: 2, focused: false });
  assert.equal(blurred.isKeyboardOpen, false);
  assert.equal(blurred.style, typing.style);
});

test('Desktop never gets a viewport override even when zoomed or focused', () => {
  const typing = measure(measure(initial, mobile), { ...mobile, visualHeight: 470, focused: true });
  assert.equal(measure(typing, { ...mobile, isMobile: false, layoutWidth: 1280, scale: 2, focused: true }), initial);
});

test('Blur during keyboard closing does not destroy the unoccluded-height baseline', () => {
  const ready = measure(initial, mobile);
  const typing = measure(ready, { ...mobile, layoutHeight: 470, visualHeight: 470, focused: true });
  assert.equal(typing.isKeyboardOpen, true);
  const blurred = measure(typing, { ...mobile, layoutHeight: 470, visualHeight: 470, focused: false });
  assert.equal(blurred.baselineHeight, 800);
  assert.equal(blurred.isKeyboardOpen, false);
  assert.equal(measure(blurred, { ...mobile, focused: true }).isKeyboardOpen, false);
});

test('Rotation resets the height baseline rather than treating landscape as a keyboard', () => {
  const ready = measure(initial, mobile);
  const rotated = measure(ready, { ...mobile, layoutWidth: 844, layoutHeight: 390, visualHeight: 390, focused: true });
  assert.equal(rotated.baselineHeight, 390);
  assert.equal(rotated.isKeyboardOpen, false);
  assert.equal(rotated.style['--visitor-height'], '390px');
});

test('Missing VisualViewport falls back to innerHeight, and transient zero sizes are ignored', () => {
  const ready = measure(initial, { ...mobile, visualHeight: undefined, visualTop: undefined, scale: undefined });
  assert.equal(ready.style['--visitor-height'], '800px');
  assert.equal(ready.style['--visitor-top'], '0px');
  assert.equal(measure(ready, { ...mobile, visualHeight: 0 }), ready);
});
