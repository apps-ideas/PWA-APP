/**
 * The embedded admin's stylesheet.
 *
 * Still hand-written CSS with no build step, for the reason admin-page.js gives:
 * this app deploys by copying the repo and running node, and a Vite + React +
 * Polaris toolchain to render forms would end that.
 *
 * Two things shape everything below. It renders inside an iframe on
 * admin.shopify.com, so it follows Polaris closely enough not to jar and honours
 * the admin's light and dark themes through one set of custom properties. And it
 * is a sidebar layout that has to survive a narrow window — a merchant on a
 * laptop with the admin's own navigation open has less room here than the
 * screenshots of this kind of app ever show.
 */

const STYLES = `
  :root { color-scheme: light dark;
          --bg:#f1f1f1; --card:#fff; --line:#e1e3e5; --text:#303030; --muted:#616161;
          --accent:#303030; --accent-fg:#fff; --field:#fff;
          --warn-bg:#fff6e0; --warn-line:#e0b44a; --ok:#0c8a5f; --bad:#c0392b;
          --nav:#1f2340; --nav-fg:#fff; --nav-muted:#a9adc9; --nav-active:rgba(255,255,255,.12);
          --tint:rgba(48,48,48,.06); --shadow:0 1px 2px rgba(0,0,0,.07); }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1a1a1a; --card:#222; --line:#3a3a3a; --text:#e3e3e3; --muted:#a0a0a0;
            --accent:#e3e3e3; --accent-fg:#1a1a1a; --field:#2b2b2b;
            --warn-bg:#3a3212; --warn-line:#7a6a20; --ok:#3fbf8f; --bad:#ff7b6b;
            --nav:#16182b; --nav-fg:#ececf4; --nav-muted:#8f93b0; --nav-active:rgba(255,255,255,.1);
            --tint:rgba(255,255,255,.06); --shadow:0 1px 2px rgba(0,0,0,.4); }
  }
  * { box-sizing: border-box; }
  /* The hidden attribute is only a UA rule of display:none, so any class that
     sets display silently outranks it. The admin toggles visibility this way in
     a dozen places, and a class setting display:flex on a hidden element would
     otherwise win. */
  [hidden] { display: none !important; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  a { color:inherit; }
  code { background:var(--tint); border-radius:4px; padding:1px 5px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; word-break:break-all; }
  .muted { color:var(--muted); }

  /* ------------------------------------------------------------ the frame */

  .shell { display:grid; grid-template-columns:236px 1fr; min-height:100vh; align-items:start; }
  .shell.collapsed { grid-template-columns:0 1fr; }

  .nav { position:sticky; top:0; align-self:start; height:100vh; overflow-y:auto;
    background:var(--nav); color:var(--nav-fg); display:flex; flex-direction:column; }
  .shell.collapsed .nav { display:none; }

  /* The running total, in the one place on the screen a merchant looks first.
     It is the app's whole reason for existing expressed as one number. */
  .navcount { padding:16px 18px; border-bottom:1px solid rgba(255,255,255,.1);
    display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
  .navcount span { font-size:12px; letter-spacing:.04em; text-transform:uppercase; color:var(--nav-muted); }
  .navcount b { font-size:19px; font-variant-numeric:tabular-nums; }

  .navgroup { margin:16px 18px 6px; font-size:11px; letter-spacing:.07em;
    text-transform:uppercase; color:var(--nav-muted); }
  .nav a { display:flex; align-items:center; gap:10px; padding:8px 18px; text-decoration:none;
    color:var(--nav-fg); font-size:13.5px; border-left:3px solid transparent; }
  .nav a:hover { background:rgba(255,255,255,.06); }
  .nav a.on { background:var(--nav-active); border-left-color:currentColor; font-weight:600; }
  .nav a svg { width:17px; height:17px; flex:0 0 auto; opacity:.85; }
  .nav a span:nth-of-type(1) { flex:1 1 auto; }
  .nav .spacer { flex:1 1 auto; }
  .navfoot { padding:14px 18px; border-top:1px solid rgba(255,255,255,.1);
    color:var(--nav-muted); font-size:12px; }

  /* In the content column's left gutter rather than over the sidebar. The
     sidebar's top two rows are the install count and the plan, both of which
     run the full width, so anything floating there covers a number or a word. */
  .navtoggle { position:fixed; top:16px; left:244px; z-index:10; width:26px; height:26px;
    padding:0; border-radius:50%; border:1px solid var(--line); background:var(--card);
    color:var(--text); font-size:14px; line-height:1; cursor:pointer; box-shadow:var(--shadow); }
  .shell.collapsed .navtoggle { left:12px; }

  .content { padding:22px 24px 90px; min-width:0; max-width:1120px; }
  .pagehead { display:flex; align-items:flex-start; gap:16px; justify-content:space-between;
    flex-wrap:wrap; margin-bottom:16px; }
  h1 { font-size:20px; margin:0; }
  .sub { margin:4px 0 0; color:var(--muted); }

  /* Only the routed page is in the document flow; the rest keep their state and
     their values, which is what lets one Save post the whole settings object
     however the merchant got there. */
  .page[hidden] { display:none; }

  /* ------------------------------------------------------------- surfaces */

  section { background:var(--card); border:1px solid var(--line); border-radius:12px;
    padding:18px 20px; margin-bottom:14px; box-shadow:var(--shadow); }
  h2 { font-size:14px; margin:0 0 4px; }
  .hint { margin:0 0 16px; color:var(--muted); font-size:13px; }
  .hint:last-child { margin-bottom:0; }
  .split { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:14px; align-items:start; }
  @media (max-width:980px) { .split { grid-template-columns:minmax(0,1fr); } }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .between { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; }

  /* --------------------------------------------------------------- fields */

  label { display:block; font-weight:500; margin-bottom:5px; }
  .sublabel { display:block; font-weight:400; color:var(--muted); font-size:12.5px; margin-top:4px; }
  input[type=text], input[type=url], input[type=number], select, textarea {
    width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px;
    background:var(--field); color:var(--text); font:inherit; }
  textarea { resize:vertical; min-height:64px; }
  input[type=color] { width:52px; height:36px; padding:2px; border:1px solid var(--line);
    border-radius:8px; background:var(--field); cursor:pointer; vertical-align:middle; }
  .colorrow { display:flex; gap:8px; align-items:center; }
  .colorrow input[type=text] { flex:1; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .check { display:flex; gap:9px; align-items:flex-start; margin-bottom:12px; }
  .check input { margin-top:3px; flex:0 0 auto; }
  .check label { font-weight:400; margin:0; }
  .cats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:2px 14px; }
  .cats .check { margin-bottom:4px; }

  /* A live count against the cap, so a merchant finds the limit while typing
     rather than in a warning after saving. */
  .counted { position:relative; }
  .counter { position:absolute; right:10px; bottom:9px; font-size:12px; color:var(--muted);
    font-variant-numeric:tabular-nums; pointer-events:none; background:var(--field); padding-left:6px; }
  .counted input[type=text] { padding-right:58px; }
  .counter.over { color:var(--bad); font-weight:600; }

  button { font:inherit; font-weight:600; cursor:pointer; border-radius:8px;
    border:1px solid transparent; padding:9px 16px; background:var(--accent); color:var(--accent-fg); }
  button.secondary { background:transparent; color:var(--text); border-color:var(--line); }
  button.danger { background:var(--bad); color:#fff; }
  button.small { padding:5px 11px; font-size:13px; }
  button.icon { padding:6px 9px; line-height:1; }
  button:disabled { opacity:.55; cursor:default; }

  /* -------------------------------------------------------------- notices */

  .banner { border-radius:10px; padding:11px 14px; margin-bottom:14px; border:1px solid; }
  .banner.warn { background:var(--warn-bg); border-color:var(--warn-line); }
  .banner.bad { background:transparent; border-color:var(--bad); color:var(--bad); }
  .banner.info { background:var(--tint); border-color:var(--line); }
  .banner ul { margin:6px 0 0; padding-left:20px; }
  .banner p { margin:4px 0 0; }

  /* The enabled/disabled strip each toggleable feature carries, so the state is
     legible without reading the checkbox it stands for. */
  .toggle { display:flex; align-items:center; justify-content:space-between; gap:12px;
    flex-wrap:wrap; border:1px solid var(--line); border-radius:10px; padding:12px 14px;
    margin-bottom:14px; background:var(--field); }
  .toggle .state { font-weight:600; }
  .toggle .state.on { color:var(--ok); }
  .toggle .state.off { color:var(--muted); }

  .savebar { position:sticky; bottom:0; margin-top:16px; padding:12px 16px; background:var(--card);
    border:1px solid var(--line); border-radius:12px; display:flex; gap:12px; align-items:center;
    box-shadow:0 -2px 10px rgba(0,0,0,.06); }
  .savebar .status { flex:1; color:var(--muted); }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--muted);
    margin-right:7px; vertical-align:middle; }
  .dot.dirty { background:var(--warn-line); }
  .dot.ok { background:var(--ok); }

  /* --------------------------------------------------------------- images */

  .preview { display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .preview img { width:72px; height:72px; border-radius:16px; border:1px solid var(--line);
    background:var(--field); object-fit:cover; }
  .shot { width:auto; max-width:180px; height:96px; border-radius:8px; }
  /* The same icon under each platform's mask. A logo that survives a square but
     loses its edges in a circle is the commonest icon mistake there is, and it
     is invisible until you look at it cropped. */
  .masks { display:flex; gap:20px; flex-wrap:wrap; margin-bottom:14px; }
  .mask { text-align:center; width:84px; }
  .mask img { width:72px; height:72px; border:1px solid var(--line); background:var(--field);
    object-fit:cover; display:block; margin:0 auto; }
  .mask .sq { border-radius:16px; }
  .mask .squircle { border-radius:22%; }
  .mask .circle { border-radius:50%; }
  .mask span { display:block; margin-top:7px; font-size:12px; color:var(--muted); line-height:1.3; }

  /* ------------------------------------------------------- device preview */

  /* Drawn in CSS rather than shipped as an image, so it repaints as the
     merchant types and needs no asset pipeline. It is a sketch of a phone, not
     a rendering of one: enough frame to read the contents as "what a customer
     sees", and no more. */
  .previewpane { position:sticky; top:16px; }
  .tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin-bottom:14px; }
  .tabs button { background:none; border:0; border-bottom:2px solid transparent; border-radius:0;
    padding:8px 12px; color:var(--muted); font-weight:500; }
  .tabs button.on { color:var(--text); border-bottom-color:var(--accent); font-weight:600; }

  .phone { width:210px; margin:0 auto; border:8px solid #2b2b33; border-radius:26px;
    background:#fff; overflow:hidden; box-shadow:0 6px 22px rgba(0,0,0,.22); }
  .screen { height:392px; position:relative; overflow:hidden; display:flex; flex-direction:column; }
  .statusbar { height:18px; flex:0 0 auto; display:flex; align-items:center;
    justify-content:space-between; padding:0 8px; font-size:8px; color:#fff; opacity:.9; }
  .fakepage { flex:1 1 auto; padding:10px; display:flex; flex-direction:column; gap:7px;
    background:#fff; }
  .fakebar { height:9px; border-radius:3px; background:rgba(128,128,128,.22); }
  .fakebar.w60 { width:60%; } .fakebar.w40 { width:40%; } .fakebar.w80 { width:80%; }
  .fakeblock { flex:1 1 auto; border-radius:6px; background:rgba(128,128,128,.14); }

  /* The install card, drawn with the merchant's own colors and copy. */
  .cardpreview { position:absolute; left:8px; right:8px; bottom:8px; border-radius:11px;
    padding:9px 10px; font-size:9px; line-height:1.45; box-shadow:0 6px 18px rgba(0,0,0,.28);
    border:1px solid rgba(128,128,128,.3); }
  .cardpreview.bar { left:0; right:0; bottom:0; border-radius:0; }
  .cardpreview.left { right:auto; width:76%; }
  .cardpreview .ct { font-weight:700; margin:0 0 2px; font-size:9.5px; }
  .cardpreview ul { margin:0 0 4px; padding:0; list-style:none; }
  .cardpreview li { padding-left:8px; position:relative; }
  .cardpreview li::before { content:"\\203A"; position:absolute; left:0; opacity:.7; }
  .cardpreview .cb { margin:0 0 6px; opacity:.8; }
  .cardpreview .cbtn { display:inline-block; padding:4px 10px; border-radius:6px;
    font-weight:700; font-size:9px; }

  /* Home screen and splash, for the Configuration page. */
  .homescreen { flex:1 1 auto; display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:7px;
    background:linear-gradient(160deg,#6ea8fe 0%,#b892ff 55%,#ff9ec7 100%); }
  .homescreen img { width:46px; height:46px; border-radius:11px; box-shadow:0 3px 9px rgba(0,0,0,.28); }
  .homescreen span { font-size:9px; color:#fff; text-shadow:0 1px 3px rgba(0,0,0,.45);
    max-width:80%; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .splashscreen { flex:1 1 auto; display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:10px; }
  .splashscreen img { width:56px; height:56px; border-radius:13px; }
  .splashscreen span { font-size:10px; font-weight:600; }
  .offlinescreen { flex:1 1 auto; display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:6px; padding:18px; text-align:center; }
  .offlinescreen b { font-size:10px; } .offlinescreen span { font-size:9px; opacity:.8; }

  /* ---------------------------------------------------------- stats & data */

  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(124px,1fr)); gap:10px; }
  .tile { border:1px solid var(--line); border-radius:10px; padding:12px 14px; background:var(--field); }
  .tile.good { background:rgba(12,138,95,.09); border-color:rgba(12,138,95,.3); }
  .tile.cool { background:var(--tint); }
  .tile .n { font-size:23px; font-weight:600; line-height:1.2; font-variant-numeric:tabular-nums; }
  .tile .k { color:var(--muted); font-size:12.5px; margin-top:3px; }

  /* Bars are divs rather than an SVG or a chart library: a few dozen rectangles
     is the whole requirement, and this way the chart inherits dark mode free. */
  .chart { display:flex; align-items:flex-end; gap:2px; height:120px; padding:0 1px;
    border-bottom:1px solid var(--line); }
  .chart .bar { flex:1 1 0; min-width:0; height:100%; display:flex; align-items:flex-end; }
  .chart .bar i { display:block; width:100%; background:var(--accent); border-radius:2px 2px 0 0;
    min-height:1px; opacity:.85; }
  .chart .bar.zero i { background:var(--line); opacity:1; }
  .axis { display:flex; justify-content:space-between; color:var(--muted); font-size:12px; margin:6px 0 0; }

  table.data { border-collapse:collapse; width:100%; font-size:13px; }
  table.data th { text-align:left; font-size:12px; letter-spacing:.03em; text-transform:uppercase;
    color:var(--muted); font-weight:600; padding:0 10px 8px 0; }
  table.data td { border-top:1px solid var(--line); padding:9px 10px 9px 0; vertical-align:top; }
  table.data td:last-child, table.data th:last-child { text-align:right; padding-right:0; }

  /* Lighthouse-style score rings, drawn with a conic gradient so there is no
     SVG to keep in step with the palette. */
  .dials { display:flex; gap:18px; flex-wrap:wrap; justify-content:center; }
  .dial { width:92px; text-align:center; }
  .dial .ring { width:62px; height:62px; margin:0 auto 7px; border-radius:50%;
    display:grid; place-items:center; font-weight:700; font-size:17px; }
  .dial .ring i { width:48px; height:48px; border-radius:50%; background:var(--card);
    display:grid; place-items:center; font-style:normal; }
  .dial small { display:block; font-size:12px; color:var(--muted); line-height:1.3; }
  .legend { display:flex; gap:14px; justify-content:center; font-size:12px; color:var(--muted);
    margin-top:14px; flex-wrap:wrap; }
  .legend b { display:inline-block; width:22px; height:4px; border-radius:2px; vertical-align:middle;
    margin-right:5px; }

  .score { display:inline-grid; place-items:center; width:30px; height:30px; border-radius:50%;
    font-size:12px; font-weight:700; border:2px solid; }
  .score.g { color:var(--ok); border-color:var(--ok); }
  .score.a { color:#b7791f; border-color:#d69e2e; }
  .score.r { color:var(--bad); border-color:var(--bad); }

  /* ------------------------------------------------------------ checklists */

  .checks { list-style:none; margin:0; padding:0; }
  .checks li { display:flex; gap:11px; align-items:flex-start; padding:11px 0;
    border-top:1px solid var(--line); }
  .checks li:first-child { border-top:0; }
  .checks .flag { flex:0 0 auto; width:19px; height:19px; border-radius:50%; display:grid;
    place-items:center; font-size:11px; font-weight:700; color:#fff; margin-top:1px; }
  .checks .flag.ok { background:var(--ok); }
  .checks .flag.no { background:var(--bad); }
  .checks .what { font-weight:500; }
  .checks .why { color:var(--muted); font-size:12.5px; margin-top:2px; word-break:break-word; }

  .repeat { display:grid; grid-template-columns:1fr auto; gap:8px; margin-bottom:8px;
    align-items:center; }
  .shortcut { display:grid; grid-template-columns:1fr 1.4fr auto; gap:8px; margin-bottom:8px;
    align-items:center; }
  @media (max-width:560px) { .shortcut { grid-template-columns:1fr auto; } }

  /* What a forced refresh does and does not reach. A table rather than prose
     because the useful thing is the per-cache verdict, and four of those in a
     paragraph is four sentences nobody finishes. */
  .what2 { border-collapse:collapse; width:100%; font-size:13px; }
  .what2 td { border-top:1px solid var(--line); padding:8px 0; vertical-align:top; }
  .what2 tr:first-child td { border-top:0; }
  .what2 td:first-child { color:var(--muted); padding-right:16px; width:36%; }
  @media (max-width:560px) {
    .what2 td { display:block; border-top:0; padding:2px 0; }
    .what2 td:first-child { width:auto; padding-top:10px; border-top:1px solid var(--line); }
    .what2 tr:first-child td:first-child { border-top:0; }
  }

  /* ------------------------------------------------------------ plans */

  /* A link styled as the primary button. Used where the action is a route or an
     external page rather than something that submits — an <a> keeps middle-click
     and "open in new tab" working, which a <button> would take away. */
  a.btn { display:inline-block; text-decoration:none; font-weight:600; border-radius:8px;
    padding:9px 16px; background:var(--accent); color:var(--accent-fg); }
  a.btn.small { padding:5px 11px; font-size:13px; }
  a.btn.secondary { background:transparent; color:var(--text); border:1px solid var(--line); }

  details { border-top:1px solid var(--line); padding:10px 0; }
  details summary { cursor:pointer; font-weight:500; }
  details p { margin:8px 0 0; color:var(--muted); }
  details:first-of-type { border-top:0; }

  .off { opacity:.5; }

  @media (max-width:760px) {
    .shell { grid-template-columns:1fr; }
    .nav { position:static; height:auto; }
    .navtoggle { display:none; }
    .content { padding:18px 14px 90px; }
  }
`;

module.exports = { STYLES };
