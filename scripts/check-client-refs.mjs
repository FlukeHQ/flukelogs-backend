#!/usr/bin/env node
//
// Catches functions that are CALLED in trip-logger/index.html but defined
// nowhere. `node --check` cannot see these: an undefined identifier is a
// runtime ReferenceError, not a syntax error, so the file parses clean and
// then throws in a captain's hand.
//
// This is not hypothetical. On 2026-08-07 removing the conditions block also
// removed the four FareHarbor booking functions sitting next to it in the
// file, while leaving fetchTodayBookings' two call sites in place. Every
// login threw. It reached production and was found by a human logging in,
// which is the same way the send-report outage was found that morning.
//
// Usage: node scripts/check-client-refs.mjs [file ...]
// Exits non-zero if anything is called but not defined.

import { readFileSync } from 'node:fs';

const FILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['trip-logger/index.html', 'trip-logger/profile.html'];

// Globals from the page's CDN scripts and the Capacitor shell, plus the
// standard library. Anything genuinely global and legitimate belongs here.
const KNOWN = new Set([
  ...('if for while switch catch return typeof new delete void do else try finally function ' +
      'class const let var await async yield in of this super instanceof').split(' '),
  ...('String Number Boolean Array Object JSON Math Date RegExp Error Promise Map Set WeakMap ' +
      'WeakSet Symbol Proxy Reflect BigInt Intl ArrayBuffer DataView Uint8Array Float32Array ' +
      'isNaN isFinite parseInt parseFloat encodeURIComponent decodeURIComponent encodeURI ' +
      'decodeURI escape unescape structuredClone queueMicrotask eval globalThis').split(' '),
  ...('window document navigator location history localStorage sessionStorage console fetch ' +
      'alert confirm prompt setTimeout setInterval clearTimeout clearInterval matchMedia ' +
      'getComputedStyle requestAnimationFrame cancelAnimationFrame performance crypto atob btoa ' +
      'URL URLSearchParams Blob File FormData FileReader Image Audio Option Headers Request ' +
      'Response AbortController TextEncoder TextDecoder MutationObserver IntersectionObserver ' +
      'ResizeObserver Notification createImageBitmap open close print scroll scrollTo focus blur ' +
      'CustomEvent Event MouseEvent KeyboardEvent DOMParser XMLHttpRequest WebSocket ' +
      'Worker Element Node HTMLElement Intl MediaRecorder MediaStream SpeechRecognition').split(' '),
  // CDN + shell globals
  ...('supabase createClient L Capacitor Chart html2canvas'.split(' ')),
]);

// Strip comments and string/template literals so prose and CSS inside them
// never look like call sites. Order matters: strings first would eat comment
// markers and vice versa, so walk the source once, character by character.
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i++;
        // Keep template substitutions: they hold real code.
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          i += 2;
          const start = i;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth > 0) i++;
          }
          // Recurse: a substitution can itself hold quoted prose, e.g.
          // `${x ? 'Change photo' : 'Add their photo (optional)'}`, which
          // otherwise reads as a call to photo().
          out += ' ' + stripCommentsAndStrings(src.slice(start, i)) + ' ';
        }
        i++;
      }
      i++;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

let failed = false;

for (const file of FILES) {
  let html;
  try {
    html = readFileSync(file, 'utf8');
  } catch {
    continue; // optional files
  }

  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const raw = blocks.join('\n');
  const code = stripCommentsAndStrings(raw);

  // IMPORTANT: definitions are collected from the RAW source, not the
  // stripped copy. The stripper is a hand-rolled scanner and can desync (a
  // regex literal containing a quote is enough). If it desyncs while building
  // `defined`, real definitions vanish and the script reports bugs that are
  // not there; worse, the same desync could hide a real one. Reading
  // definitions from raw makes `defined` a superset, so this script can only
  // ever be too quiet about a definition, never wrongly loud. Call sites still
  // come from the stripped copy, which is what keeps prose out.
  const defined = new Set();
  for (const re of [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g, // object methods
    /\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,                   // shorthand methods
  ]) {
    for (const m of raw.matchAll(re)) defined.add(m[1]);
  }
  // Destructured bindings: const { a, b } = x
  for (const m of raw.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().replace(/^\.\.\./, '').split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
    }
  }
  // Function parameters
  for (const m of raw.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^\.\.\./, '').split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
    }
  }

  for (const m of raw.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) defined.add(m[1]);

  // Call sites in code, plus inline handlers in the markup.
  const calls = new Set();
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);
  for (const m of html.matchAll(/\bon\w+="[^"]*?(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);

  const missing = [...calls].filter(c => !defined.has(c) && !KNOWN.has(c)).sort();

  if (missing.length) {
    failed = true;
    console.error(`\n${file}: called but never defined`);
    for (const name of missing) {
      const line = raw.split('\n').findIndex(l => new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(l));
      console.error(`  ${name}()${line >= 0 ? `  (first use near script line ${line + 1})` : ''}`);
    }
  } else {
    console.log(`${file}: OK, every call site resolves`);
  }
}

process.exit(failed ? 1 : 0);
