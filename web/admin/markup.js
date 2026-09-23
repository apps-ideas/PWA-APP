/**
 * Markup helpers for the embedded admin.
 *
 * Every function here returns an HTML string, and every one of them escapes what
 * it is given. The admin renders merchant-supplied values — an app name, a
 * benefit line, a precache URL — and the fact that those values also reach a
 * manifest and a storefront script is exactly why none of them may be
 * interpolated raw.
 *
 * The one exception is the `hint` and `sublabel` copy, which is written here in
 * this repository and carries deliberate markup (<code>, <strong>, an entity).
 * Those parameters are documented as trusted; nothing merchant-supplied is ever
 * passed to them.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

function field(id, label, input, sublabel) {
  return (
    '<div><label for="' + id + '">' + escapeHtml(label) + '</label>' + input +
    (sublabel ? '<span class="sublabel">' + sublabel + '</span>' : '') + '</div>'
  );
}

function text(id, placeholder) {
  return '<input type="text" id="' + id + '" placeholder="' + escapeHtml(placeholder || '') + '">';
}

/**
 * A text input with a live "used/allowed" count beside it.
 *
 * The cap is the one validate.js enforces, declared here as a data attribute so
 * the two cannot drift apart silently — the client reads it, and a mismatch
 * shows up as a counter that disagrees with the warning after a save.
 */
function counted(id, max, placeholder) {
  return (
    '<div class="counted">' +
    '<input type="text" id="' + id + '" data-count="' + max + '" maxlength="' + max + '" ' +
    'placeholder="' + escapeHtml(placeholder || '') + '">' +
    '<span class="counter" data-counter-for="' + id + '"></span>' +
    '</div>'
  );
}

function area(id, max, placeholder) {
  return (
    '<textarea id="' + id + '" data-count="' + max + '" maxlength="' + max + '" ' +
    'placeholder="' + escapeHtml(placeholder || '') + '"></textarea>' +
    '<span class="sublabel" data-counter-for="' + id + '"></span>'
  );
}

/**
 * `selected` is only for the selects that are not settings — the report's
 * strategy, the analytics period. Everything bound to a setting gets its value
 * from render() instead, and marking one here would be a second default to keep
 * in step with the first.
 */
function select(id, options, selected) {
  return (
    '<select id="' + id + '">' +
    options.map((o) =>
      '<option value="' + escapeHtml(o[0]) + '"' + (o[0] === selected ? ' selected' : '') + '>' +
      escapeHtml(o[1]) + '</option>'
    ).join('') +
    '</select>'
  );
}

function colorField(id, label, sublabel) {
  return field(
    id,
    label,
    '<div class="colorrow"><input type="color" id="' + id + 'Picker" aria-label="' + escapeHtml(label) + ' picker">' +
      '<input type="text" id="' + id + '" placeholder="#111111" spellcheck="false"></div>',
    sublabel
  );
}

function checkbox(id, label) {
  return '<div class="check"><input type="checkbox" id="' + id + '"><label for="' + id + '">' + label + '</label></div>';
}

/**
 * The enabled/disabled strip a toggleable feature carries.
 *
 * It is a button rather than a checkbox because it saves on click — the state
 * it reports is the state on the server, and a checkbox that meant "will be on
 * once you scroll down and press Save" would be a different promise than the
 * words next to it make.
 */
function toggleStrip(id, label) {
  return (
    '<div class="toggle">' +
    '<div>' + escapeHtml(label) + ': <span class="state" data-toggle-state="' + id + '">…</span></div>' +
    '<button type="button" class="small" data-toggle="' + id + '">…</button>' +
    '</div>'
  );
}

/**
 * A page's own save bar. Every page posts the whole settings object — see the
 * client's collect() — so which one is pressed does not change what is saved,
 * only where the merchant happened to be standing.
 *
 * Addressed by data attribute rather than by id precisely because there are
 * five of these in the document: duplicate ids would make getElementById return
 * whichever page happened to be first, and a merchant editing on any other page
 * would watch a status line that never moved.
 */
function saveBar() {
  return (
    '<div class="savebar">' +
    '<span class="status"><span class="dot" data-savedot></span>' +
    '<span data-savestatus>Loading…</span></span>' +
    '<button type="button" class="secondary" data-discard>Discard changes</button>' +
    '<button type="button" data-save disabled>Save</button>' +
    '</div>'
  );
}

/**
 * Sidebar icons.
 *
 * Inline SVG, 20-unit box, stroked in currentColor so they take the sidebar's
 * color and its active state without a second rule. Drawn here rather than
 * pulled from an icon package because five hundred bytes of path data is
 * cheaper than a dependency this app would otherwise not have.
 */
const ICONS = {
  home: '<path d="M3 9l7-6 7 6v8a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1z"/>',
  config: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 8h6M7 12h4"/>',
  message: '<path d="M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8l-4 3z"/>',
  cache: '<ellipse cx="10" cy="5" rx="6" ry="2.5"/><path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5"/><path d="M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5"/>',
  offline: '<path d="M3 3l14 14"/><path d="M5.5 9a6.5 6.5 0 0 1 3-1.7M2.5 6.5A11 11 0 0 1 6 4.6M14.5 9a6.5 6.5 0 0 0-2-1.4M17.5 6.5a11 11 0 0 0-3.4-1.9"/><path d="M8 12.5a3 3 0 0 1 4 0"/><circle cx="10" cy="15.5" r=".8" fill="currentColor"/>',
  settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/>',
  report: '<path d="M3 17h14"/><rect x="4" y="9" width="3" height="6"/><rect x="9" y="5" width="3" height="10"/><rect x="14" y="11" width="3" height="4"/>',
  analytics: '<path d="M3 15l4-5 3 3 6-8"/><path d="M3 3v14h14"/>',
  wizard: '<path d="M10 2.5l1.8 4 4.2.5-3.1 2.9.9 4.3L10 12l-3.8 2.2.9-4.3L4 7l4.2-.5z"/>',
  faq: '<circle cx="10" cy="10" r="7.5"/><path d="M8 8a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4"/><circle cx="10" cy="14" r=".7" fill="currentColor"/>',
};

/** A sidebar link. */
function navItem(route, icon, label) {
  return (
    '<a href="#/' + route + '" data-route="' + route + '">' +
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + ICONS[icon] + '</svg>' +
    '<span>' + escapeHtml(label) + '</span></a>'
  );
}

module.exports = {
  area,
  checkbox,
  colorField,
  counted,
  escapeHtml,
  field,
  navItem,
  saveBar,
  select,
  text,
  toggleStrip,
};
