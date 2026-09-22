/**
 * FluxFilm — one wording, three channels.
 *
 * Nearly every message we send a customer is read on WhatsApp, so each one is written ONCE using WhatsApp's own
 * markers (*bold*), and the other channels render that same string:
 *
 *   wa(s)    → exactly as written; WhatsApp draws the bold itself
 *   plain(s) → markers removed, for a screen that prints plain text (the shop's own "renewed" line)
 *   html(s)  → escaped, markers become <b>, for an email
 *
 * Why one source: the same sentence used to exist three times (shop screen, WhatsApp, email) and they drifted.
 * Now a wording change lands everywhere at once, and nothing can leak a stray asterisk into an email.
 *
 * clean() is the other half of the deal: anything the owner typed (a plan name, a customer name) is stripped of
 * * _ ~ ` before it goes into a message, so "Netflix *Special*" cannot break the bold around it.
 *
 * Pure: no database, no environment, no I/O (test/message-style.test.js).
 */
const STARS = /\*([^*\n]+)\*/g;
const s = (v) => String(v == null ? '' : v);

/** As written — WhatsApp understands the markers. */
const wa = (v) => s(v);

/** Markers removed, for plain text on a screen. */
const plain = (v) => s(v).replace(STARS, '$1');

const escHtml = (v) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Escaped HTML with <b> where the markers were, and newlines kept. */
const html = (v) => escHtml(v).replace(STARS, '<b>$1</b>').replace(/\n/g, '<br>');

/** Text we did not write (a plan name, a customer name) — it must not carry markers of its own. */
const clean = (v) => s(v).replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();

/** First name only, and never a number or an email — the same rule the storefront uses. */
const firstName = (v) => {
  const w = clean(v).split(/\s+/)[0] || '';
  return /^[\p{L}\p{M}.'’-]{2,20}$/u.test(w) ? w : '';
};

/**
 * Lines → one message: drop the empty sections, never two blank lines in a row, no blank line at either end.
 * Pass '' where a blank line belongs; pass null/false for "nothing here".
 */
const join = (lines) => (lines || []).filter((l) => l != null && l !== false).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');

module.exports = { wa, plain, html, clean, firstName, join, STARS };
