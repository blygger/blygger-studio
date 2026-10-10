// Public-page embeds (studio#9). Presentation only, done entirely in the
// browser on the server-rendered public pages.
//
// Nothing here touches content_html. The stored and served item bytes are the
// wire format (§5): baking a facade into them would put a new construct on the
// wire, the importer's sanitizer would strip its data attributes on every
// other node, and a new class there is a CSS-contract matter. So the page
// script reads the item HTML as published and upgrades it on screen, which
// also means every version ever published (pinned ones included, whose bytes
// never change) gets the same treatment with no re-render.
//
// The rules:
//  - A paragraph whose only content is one link, whose text is its own URL (a
//    pasted or autolinked address, not a titled link in prose), pointing at a
//    YouTube video, becomes a click-to-play poster. Nothing is loaded from
//    YouTube itself until the reader presses play; the poster comes from
//    i.ytimg.com with no referrer, and the player from youtube-nocookie.com.
//  - An off-origin image that fails to load becomes "Image: <alt> ↗ (host)",
//    a link to the image, instead of a broken-image icon.
//  - With scripts off the link stays a link, exactly as published.
//
// Inline-script hazard: this is a TS template literal emitted as JavaScript.
// Write no backslashes in it (character classes like [0-9] and [/] instead of
// \d and \/), so nothing can be eaten by the template literal on the way out.
// test/inline-scripts.test.ts compiles it.

/**
 * `ytParse(href)` → `{ id, start }` or null. Kept as its own string so the
 * Worker suite can compile and exercise the exact code the page runs.
 * Strict: the URL must parse, be http(s) with no credentials or port, sit on
 * one of YouTube's own hosts, use one of the video path shapes, and carry an
 * 11-character id from YouTube's alphabet.
 */
export const YT_PARSE_JS = `
function ytStart(t) {
  if (!t) return 0;
  var m = /^(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s?)?$/.exec(t);
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}
function ytParse(href) {
  var u;
  try { u = new URL(href); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  var host = u.hostname.toLowerCase();
  var parts = u.pathname.split("/");
  if (parts.length === 4 && parts[3] === "") parts.pop();
  var id = null;
  if (host === "youtu.be" || host === "www.youtu.be") {
    if (parts.length === 2) id = parts[1];
  } else if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (parts.length === 2 && parts[1] === "watch") id = u.searchParams.get("v");
    else if (parts.length === 3 && (parts[1] === "shorts" || parts[1] === "live" || parts[1] === "embed")) id = parts[2];
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return { id: id, start: ytStart(u.searchParams.get("t") || u.searchParams.get("start")) };
}
`;

export const EMBED_SCRIPT = `
(function () {
  if (!window.URL || !document.querySelector("article")) return;
${YT_PARSE_JS}
  // Link text that is the URL itself, give or take the scheme linkify drops.
  function bare(text, href) {
    function norm(s) {
      s = s.trim().replace(/^https?:[/][/]/i, "").replace(/[/]$/, "");
      try { s = decodeURI(s); } catch (e) {}
      return s;
    }
    return text.trim() !== "" && norm(text) === norm(href);
  }

  function facade(p) {
    // Markdown paragraphs carry no class; every apparatus paragraph does.
    if (p.className || p.children.length !== 1) return;
    var a = p.children[0];
    if (a.tagName !== "A" || a.children.length) return;
    var href = a.getAttribute("href") || "";
    var text = a.textContent || "";
    if ((p.textContent || "").trim() !== text.trim() || !bare(text, href)) return;
    var v = ytParse(href);
    if (!v) return;
    var fig = document.createElement("figure");
    fig.className = "yt-facade";
    fig.setAttribute("data-yt", v.id);
    if (v.start) fig.setAttribute("data-yt-start", String(v.start));
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "yt-play";
    btn.setAttribute("aria-label", "Play video: " + text.trim());
    var img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.src = "https://i.ytimg.com/vi/" + v.id + "/hqdefault.jpg";
    btn.appendChild(img);
    var cap = document.createElement("figcaption");
    // The published link itself, moved rather than copied: it keeps whatever
    // the author's bytes gave it, and stays the way to YouTube proper.
    cap.appendChild(a);
    fig.appendChild(btn);
    fig.appendChild(cap);
    p.parentNode.replaceChild(fig, p);
  }

  function play(btn) {
    var fig = btn.closest(".yt-facade");
    var id = fig && fig.getAttribute("data-yt");
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return;
    var start = Number(fig.getAttribute("data-yt-start")) || 0;
    var f = document.createElement("iframe");
    f.className = "yt-frame";
    f.title = "YouTube video player";
    f.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
    f.setAttribute("allowfullscreen", "");
    // YouTube's player refuses to run without a referrer; send only the origin.
    f.referrerPolicy = "strict-origin-when-cross-origin";
    f.src = "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1&rel=0" + (start ? "&start=" + start : "");
    btn.parentNode.replaceChild(f, btn);
    try { f.focus(); } catch (e) {}
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest(".yt-play") : null;
    if (btn) { e.preventDefault(); play(btn); }
  });

  // An off-origin image that fails (a hotlink block, a bot challenge, a dead
  // host) becomes a visible link to it instead of a broken-image icon. Own
  // images (attachments, the avatar) are left alone, and only http(s) URLs
  // become links, the same followable rule the server applies to hrefs.
  function offOrigin(img) {
    if (!img || img.tagName !== "IMG" || !img.closest("article") || img.closest(".yt-facade")) return null;
    var src = img.getAttribute("src");
    if (!src) return null;
    try {
      var u = new URL(src, location.href);
      if (u.origin === location.origin || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
      return u;
    } catch (e) { return null; }
  }
  function fallback(img) {
    var u = offOrigin(img);
    if (!u || !img.parentNode) return;
    var alt = (img.getAttribute("alt") || "").trim();
    // Inside a link already, a second link would nest; say it in a span.
    var el = document.createElement(img.parentNode.closest("a") ? "span" : "a");
    if (el.tagName === "A") { el.href = u.href; el.rel = "noopener noreferrer"; }
    el.className = "img-fallback";
    el.title = "This image could not be loaded from " + u.host;
    el.textContent = "Image" + (alt ? ": " + alt : "") + " ↗ (" + u.host + ")";
    img.parentNode.replaceChild(el, img);
  }
  // error does not bubble, so listen in the capture phase. That also catches
  // lazy images and ones a swapped-in version brings.
  document.addEventListener("error", function (e) { fallback(e.target); }, true);
  // One that failed before this script ran has fired its error already.
  // decode() rejects only for a broken image, so an image that loaded with no
  // intrinsic size (an SVG, say) is not mistaken for one.
  function sweep(img) {
    if (!img.complete || img.naturalWidth !== 0 || !offOrigin(img)) return;
    if (img.decode) img.decode().then(null, function () { fallback(img); });
    else fallback(img);
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches("article p")) facade(root);
    var ps = root.querySelectorAll("article p");
    for (var i = 0; i < ps.length; i++) facade(ps[i]);
    if (root.tagName === "IMG") sweep(root);
    var imgs = root.querySelectorAll("article img");
    for (var k = 0; k < imgs.length; k++) sweep(imgs[k]);
  }
  scan(document.documentElement);
  // The version carousel swaps a pinned version's body in place.
  if (window.MutationObserver) {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++)
        for (var j = 0; j < records[i].addedNodes.length; j++) scan(records[i].addedNodes[j]);
    }).observe(document.body, { childList: true, subtree: true });
  }
})();
`;

/** Appended to the public style.css. Theme tokens only, so every theme fits. */
export const EMBED_CSS = `
/* Click-to-play YouTube poster (EMBED_SCRIPT, studio#9). A 16:9 box from
   first paint, so pressing play swaps one box for another of the same size. */
.yt-facade { margin: 1rem 0; }
.yt-facade .yt-play, .yt-facade .yt-frame {
  position: relative; display: block; box-sizing: border-box; width: 100%; aspect-ratio: 16 / 9;
  margin: 0; padding: 0; border: 1px solid var(--rule); border-radius: 2px; overflow: hidden;
  background: var(--paper-sunk); cursor: pointer; font: inherit; color: inherit;
}
.yt-facade .yt-frame { border: 0; cursor: auto; }
article .yt-facade .yt-play img { position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; object-fit: cover; border-radius: 0; }
.yt-facade .yt-play::before {
  content: ""; position: absolute; top: 50%; left: 50%; z-index: 1; width: 3.6rem; height: 3.6rem; margin: -1.8rem 0 0 -1.8rem;
  border-radius: 50%; background: var(--pencil); box-shadow: 0 2px 10px rgb(0 0 0 / 0.3); transition: transform 0.15s ease;
}
.yt-facade .yt-play::after {
  content: ""; position: absolute; top: 50%; left: 50%; z-index: 2; margin: -0.7rem 0 0 -0.4rem;
  border-style: solid; border-width: 0.7rem 0 0.7rem 1.15rem; border-color: transparent transparent transparent var(--paper);
}
.yt-facade .yt-play:hover::before, .yt-facade .yt-play:focus-visible::before { transform: scale(1.07); }
.yt-facade figcaption { margin-top: 0.35rem; font: var(--apparatus); color: var(--ink-soft); overflow-wrap: anywhere; }
.yt-facade figcaption a { color: var(--ink-soft); }
@media (prefers-reduced-motion: reduce) { .yt-facade .yt-play::before { transition: none; } }
/* An off-origin image that failed to load, shown as a link to it. */
.img-fallback {
  display: inline-block; padding: 0.35rem 0.6rem; border: 1px dashed var(--rule); border-radius: 2px;
  font: var(--apparatus); color: var(--pencil); overflow-wrap: anywhere;
}
`;
