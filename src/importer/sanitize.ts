// Publisher HTML is untrusted. Keep ordinary editorial HTML, not active or
// foreign documents. Raw rows remain unchanged; sanitize every receiving render.
import { decodeHTML, decodeHTMLAttribute } from 'entities';
import { renderTex, texAsText } from '../math-render.ts';

const TAGS = new Set('a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup data dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody td th thead time tr u ul var wbr'.split(' '));
// Unlisted tags are unwrapped so their text and listed children survive
// (<picture> around an <img>, <font>, <video> fallback text). These are dropped
// whole instead: active or foreign content, and every raw-text or RCDATA
// element, whose content would turn into live markup if it were unwrapped.
const DROP = new Set('script style template noscript textarea title xmp plaintext listing noembed noframes iframe frame frameset object embed applet svg math select head base link meta form'.split(' '));
const ATTRIBUTES = new Set('alt class title width height colspan rowspan scope datetime open dir lang'.split(' '));

function safeUrl(raw: string, image: boolean) {
  // HTMLRewriter exposes encoded attribute bytes. Decode with an HTML attribute
  // parser before WHATWG URL normalization; checking literal spelling misses
  // entities and embedded tabs/newlines. Keep the original bytes after validation.
  try {
    const protocol = new URL(decodeHTMLAttribute(raw), 'https://import.invalid/').protocol;
    return (image ? ['https:', 'http:'] : ['https:', 'http:', 'mailto:', 'tel:']).includes(protocol);
  } catch { return false; }
}
/**
 * Mathematics (#105, spec §14; v0.4-plan §23.4): a `math` element is never kept.
 * This rewriter passes what it keeps through as the bytes it read, and inside
 * `math` the browser may read those bytes differently from it. So each formula
 * is **redrawn**: the element is discarded, and the decoded text of its first
 * `application/x-tex` annotation is drawn afresh by our own renderer, which is
 * the one thing taken from inside it. One without that annotation is dropped.
 *
 * Two passes. The first changes nothing but a marker attribute, with a name no
 * input can know, on every `math` element, and collects each top-level one's
 * TeX and display flag. The second is the sanitizer, which replaces a marked
 * top-level `math` with a text token (also unknowable to the input) and removes
 * any other. The tokens are then swapped for the drawings, so a formula lands
 * only where this parser itself saw the element.
 */
interface Formula { tex: string | null; display: boolean }
const FORMULAS_MAX = 1000;
const nonce = () => crypto.getRandomValues(new Uint32Array(4)).reduce((acc, n) => acc + n.toString(36), '');

async function collectFormulas(html: string, marker: string) {
  const formulas: Formula[] = [];
  const open: number[] = [];
  let reading: { formula: Formula; text: string } | null = null;
  const marked = await new HTMLRewriter()
    .on('math', {
      element(el) {
        const top = open.length === 0;
        const index = formulas.length;
        formulas.push({ tex: null, display: top && el.getAttribute('display') === 'block' });
        el.setAttribute(marker, top ? String(index) : 'nested');
        // `<math/>` has no content and no end tag to wait for.
        try {
          el.onEndTag(() => { open.pop(); });
          open.push(index);
        } catch { /* no end tag */ }
      },
    })
    .on('annotation', {
      element(el) {
        const formula = open.length === 1 ? formulas[open[0]] : undefined;
        if (!formula || formula.tex !== null || el.getAttribute('encoding') !== 'application/x-tex') return;
        try {
          el.onEndTag(() => {
            if (reading) reading.formula.tex = decodeHTML(reading.text);
            reading = null;
          });
          reading = { formula, text: '' };
        } catch { /* `<annotation/>`: nothing to read */ }
      },
      text(chunk) {
        if (reading) reading.text += chunk.text;
      },
    })
    .transform(new Response(html)).text();
  return { marked, formulas };
}

/** `makeNonce` is for tests, which need to know a token to show it is never substituted where the input put it. */
export async function sanitizeHtml(html: string, makeNonce: () => string = nonce): Promise<string> {
  if (!/<math/i.test(html)) return sanitizeMarkup(html, null);
  const marker = `data-m${makeNonce()}`;
  let token = `m${makeNonce()}t`;
  while (html.includes(token)) token = `m${makeNonce()}t`;
  const { marked, formulas } = await collectFormulas(html, marker);
  const out = await sanitizeMarkup(marked, { marker, token, formulas });
  let drawn = 0;
  return out.replace(new RegExp(`${token}(\\d+)x`, 'g'), (_, index: string) => {
    const formula = formulas[Number(index)];
    if (!formula?.tex) return '';
    if (++drawn > FORMULAS_MAX) return texAsText(formula.tex, formula.display);
    const { html: drawing, error } = renderTex(formula.tex, formula.display);
    return error ? texAsText(formula.tex, formula.display) : drawing;
  });
}

async function sanitizeMarkup(html: string, math: { marker: string; token: string; formulas: Formula[] } | null): Promise<string> {
  const rewriter = new HTMLRewriter().on('*', {
    element(el) {
      if (el.tagName === 'math') {
        const index = math ? el.getAttribute(math.marker) : null;
        if (math && index !== null && /^\d+$/.test(index) && math.formulas[Number(index)]?.tex) {
          el.replace(`${math.token}${index}x`, { html: false });
        } else {
          el.remove();
        }
        return;
      }
      if (DROP.has(el.tagName)) { el.remove(); return; }
      if (!TAGS.has(el.tagName)) { el.removeAndKeepContent(); return; }
      for (const [name, value] of [...el.attributes]) {
        const key = name.toLowerCase();
        if (key === 'href' && el.tagName === 'a') {
          if (!safeUrl(value, false)) el.removeAttribute(name);
        } else if (key === 'src' && el.tagName === 'img') {
          if (!safeUrl(value, true)) el.removeAttribute(name);
        } else if (key === 'value' && el.tagName === 'data') {
          // A mention's alternate identifiers (tn-6 section 5.3): inert text, never fetched.
        } else if (!ATTRIBUTES.has(key) && !key.startsWith('data-blyg-')) {
          // Exclude handlers, style, namespace URLs, animation, srcdoc and named
          // DOM properties rather than growing a list of known attack spellings.
          el.removeAttribute(name);
        }
      }
    },
  });
  return await rewriter.transform(new Response(html)).text();
}
