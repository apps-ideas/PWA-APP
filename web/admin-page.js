/**
 * The embedded admin.
 *
 * Still a plain server-rendered shell plus one script — no React, no Polaris, no
 * build step. This app deploys by copying the repo and running node, which is
 * the same reason it has no OAuth flow and no session store, and a toolchain to
 * render forms would end all three.
 *
 * What grew is the surface, not the machinery. The admin is now ten pages behind
 * a sidebar rather than one long column, so the markup, the stylesheet and the
 * client script live in web/admin/ instead of in one file:
 *
 *   admin/styles.js   the stylesheet
 *   admin/markup.js   form and navigation helpers, and the escaping they do
 *   admin/views.js    the document: sidebar plus every page, all present at once
 *   admin/client.js   the browser script, as a string
 *
 * This file is the seam server.js talks to, and exists so that split stayed
 * invisible from the outside.
 */

const views = require('./admin/views.js');
const client = require('./admin/client.js');

module.exports = { html: views.html, script: client.script };
