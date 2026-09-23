/**
 * FluxFilm — the three pictures in 🧰 Tools → 🏠 Netflix Household ("tap the one that looks like your screen").
 *
 * Drawn rather than photographed. A phone snap of a TV comes with glare, an angle and a real customer's email on
 * it, weighs ~70 KB, and turns to mush in a 104 px thumbnail. These are ~3 KB of SVG each: crisp at any size,
 * nothing private in them, and drawn so that each one is recognisable by its SHAPE before any text is readable —
 * a sentence with two buttons, four digit boxes, a padlock over six boxes.
 *
 * They are the DEFAULT. If the owner uploads a real screenshot in admin → 📺 Netflix helper → 🖼 What the customer
 * sees, that photo is used for that choice instead. Loaded by index.html and by the admin panel, from /household-pics.js.
 *
 * Wording is the plain on-screen text a customer is looking at, so they can match it. No brand logo is drawn.
 */
(function () {
  var FONT = 'Arial,Helvetica,sans-serif';

  // The dark red-to-black wash every one of these Netflix screens has.
  function frame(id, inner) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 336 248" width="336" height="248">'
      + '<defs><radialGradient id="' + id + '" cx="18%" cy="8%" r="95%">'
      + '<stop offset="0" stop-color="#5c1116"/><stop offset="55%" stop-color="#1d0a0d"/><stop offset="1" stop-color="#0b0b0f"/>'
      + '</radialGradient></defs>'
      + '<rect width="336" height="248" rx="10" fill="url(#' + id + ')"/>'
      + inner + '</svg>';
  }
  function card(y, h) {
    return '<rect x="26" y="' + y + '" width="284" height="' + h + '" rx="14" fill="#141418" fill-opacity=".72" stroke="#3a3a42"/>';
  }
  function text(x, y, size, fill, str, opts) {
    return '<text x="' + x + '" y="' + y + '"' + ((opts && opts.mid) ? ' text-anchor="middle"' : '')
      + ' font-family="' + FONT + '" font-size="' + size + '"' + ((opts && opts.bold) ? ' font-weight="700"' : '')
      + ' fill="' + fill + '">' + str + '</text>';
  }
  function box(x, y, w, h, r) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + r + '" fill="#232329" stroke="#4a4a55" stroke-width="1.5"/>';
  }
  function digits(list, y, size) {
    return list.map(function (d) { return text(d[0], y, size, '#fff', d[1], { mid: true, bold: true }); }).join('');
  }

  // 1 · "not part of your household" — one big sentence and TWO buttons.
  var household = frame('ffhh1',
    card(44, 160)
    + text(46, 82, 21, '#fff', "Your TV isn't part of", { bold: true })
    + text(46, 108, 21, '#fff', 'the Household', { bold: true })
    + text(46, 134, 12, '#b9b9c2', 'Did we get it wrong? You have options.')
    + '<rect x="46" y="150" width="150" height="34" rx="6" fill="#e8e8ec"/>'
    + text(121, 172, 12.5, '#141418', 'Update Household', { mid: true, bold: true })
    + '<rect x="206" y="150" width="86" height="34" rx="6" fill="#2e2e36"/>'
    + text(249, 172, 12.5, '#f1f1f4', "I'm Traveling", { mid: true, bold: true }));

  // 2 · the travelling code — FOUR digit boxes.
  var travel = frame('ffhh2',
    card(40, 168)
    + text(168, 76, 20, '#fff', 'Enter this code', { mid: true, bold: true })
    + text(168, 98, 12, '#b9b9c2', '4 digits, to watch away from home', { mid: true })
    + box(56, 116, 48, 58, 8) + box(116, 116, 48, 58, 8) + box(176, 116, 48, 58, 8) + box(236, 116, 48, 58, 8)
    + digits([[80, '4'], [140, '7'], [200, '2'], [260, '9']], 158, 30)
    + text(168, 196, 11.5, '#8d8d99', '&#8220;Watch Temporarily&#8221; / &#8220;I&#8217;m Traveling&#8221;', { mid: true }));

  // 3 · the 6-digit verification code — a padlock over SIX boxes.
  var signin = frame('ffhh3',
    card(40, 168)
    + '<g transform="translate(152,58)"><rect x="0" y="12" width="32" height="24" rx="5" fill="#e50914"/>'
    + '<path d="M6 12 V7 a10 10 0 0 1 20 0 V12" fill="none" stroke="#e50914" stroke-width="4.5"/>'
    + '<circle cx="16" cy="24" r="3.4" fill="#141418"/></g>'
    + text(168, 124, 19, '#fff', 'Verify with this code', { mid: true, bold: true })
    + box(46, 140, 36, 48, 7) + box(88, 140, 36, 48, 7) + box(130, 140, 36, 48, 7)
    + box(172, 140, 36, 48, 7) + box(214, 140, 36, 48, 7) + box(256, 140, 36, 48, 7)
    + digits([[64, '0'], [106, '6'], [148, '8'], [190, '0'], [232, '9'], [274, '7']], 175, 25));

  var url = function (svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); };
  window.FF_HH_PICS = { household: url(household), travel: url(travel), signin: url(signin) };
})();
