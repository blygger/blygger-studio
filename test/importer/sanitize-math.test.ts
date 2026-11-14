// The reader redraws mathematics (#105 as amended, v0.4-plan §23.4; opus-brief
// session 69, invariant 4). These pin the four properties: nothing inside a
// foreign `math` element is copied but its TeX; the drawing lands only where
// the parser saw the element; drawing is bounded; and what the renderer emits
// is checked before it is used.
import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../../src/importer/sanitize.ts';
import { renderMarkdown } from '../../src/markdown.ts';
import { allowedMath, renderTex, TEX_MAX } from '../../src/math-render.ts';
import { importedHtmlAttacks } from '../fixtures/imported-html-attacks.ts';

const drawing = (tex: string, display = false) => renderTex(tex, display).html;
/** Every tag name in some HTML, lower-cased. */
const tags = (html: string) => [...html.matchAll(/<([a-zA-Z][^\s/>]*)/g)].map((m) => m[1].toLowerCase());

describe('a formula is redrawn from its TeX', () => {
  it('our own formula comes back byte for byte, so a fragment and a thread agree', async () => {
    for (const md of ['$x^2$', '$$\\int_0^1 f(x)\\,dx$$', 'a $\\frac{1}{2}$ b $\\sqrt{2}$ c', '$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$']) {
      const html = renderMarkdown(md);
      expect(await sanitizeHtml(html)).toBe(html);
    }
  });

  it('no formula carries style, at publish or after redrawing', async () => {
    const html = renderMarkdown('$$\\color{red}{x} + \\boxed{y}$$');
    expect(html).toContain('<math display="block"');
    expect(html).not.toMatch(/\sstyle=/);
    expect(await sanitizeHtml(html)).not.toMatch(/\sstyle=/);
  });

  it('a foreign formula is our drawing of its annotation, and nothing else of it survives', async () => {
    const foreign = '<p>before <math display="block" class="x" style="position:fixed" onclick="evil()"><semantics><mrow><mi mathcolor="red" href="https://evil.example/">q</mi><mglyph src="x"/></mrow><annotation encoding="application/x-tex">a+b</annotation></semantics></math> after</p>';
    expect(await sanitizeHtml(foreign)).toBe(`<p>before ${drawing('a+b', true)} after</p>`);
  });

  it('only the first TeX annotation of the outermost formula is read', async () => {
    const html = '<math><semantics><mrow><math><semantics><mi>z</mi><annotation encoding="application/x-tex">inner</annotation></semantics></math></mrow><annotation encoding="text/plain">plain</annotation><annotation encoding="application/x-tex">outer</annotation><annotation encoding="application/x-tex">second</annotation></semantics></math>';
    expect(await sanitizeHtml(html)).toBe(drawing('outer'));
  });

  it('entities in the annotation are its text, and markup there is only text', async () => {
    expect(await sanitizeHtml('<math><annotation encoding="application/x-tex">a &lt; b</annotation></math>')).toBe(drawing('a < b'));
    // `&` is TeX's alignment character, so this one does not parse, and is shown as written.
    expect(await sanitizeHtml('<math><annotation encoding="application/x-tex">a &amp;&amp; c</annotation></math>')).toBe('<code class="math-source">$a &amp;&amp; c$</code>');
    const out = await sanitizeHtml('<math><annotation encoding="application/x-tex">&lt;img src=x onerror=alert(1)&gt;</annotation></math>');
    expect(tags(out).every((name) => name !== 'img')).toBe(true);
    expect(allowedMath(out.replace(/<code[^>]*>[\s\S]*<\/code>/, ''))).toBe(true);
  });

  it('a formula without a TeX annotation is dropped, as every formula was before', async () => {
    expect(await sanitizeHtml('<p>a <math><mi>x</mi></math> b</p>')).toBe('<p>a  b</p>');
    expect(await sanitizeHtml('<p>a <math><annotation encoding="application/x-tex"></annotation></math> b</p>')).toBe('<p>a  b</p>');
    expect(await sanitizeHtml('<p>a <math/> b</p>')).toBe('<p>a  b</p>');
  });

  it('an unclosed formula swallows what follows, as a browser would, and is still only its drawing', async () => {
    const out = await sanitizeHtml('<p>a <math><annotation encoding="application/x-tex">x</annotation><mtext><img src=x onerror=alert(1)></mtext><p>later');
    expect(out).toContain(drawing('x'));
    expect(out).not.toContain('img');
    expect(out).not.toContain('onerror');
  });

  it.each(importedHtmlAttacks.filter((attack) => attack.id.startsWith('math') || attack.id === 'mutation'))('the corpus case $id leaves only allowed MathML', async (attack) => {
    const out = await sanitizeHtml(attack.html);
    // Judged by structure: the TeX of a hostile annotation is text, and may spell anything.
    expect(tags(out).filter((name) => ['img', 'style', 'table', 'mglyph', 'annotation-xml', 'script'].includes(name))).toEqual([]);
    for (const tag of out.match(/<[^>]*>/g) ?? []) expect(tag).not.toMatch(/\s(on\w+|href|xlink:href|src|style)=/i);
    const formulas = [...out.matchAll(/<math[\s\S]*?<\/math>/g)].map((m) => m[0]);
    for (const formula of formulas) expect(allowedMath(formula)).toBe(true);
  });
});

describe('the drawing lands only where the parser saw the element', () => {
  it('a token in an attribute, a comment or text is never substituted', async () => {
    const nonces = ['marker', 'known', 'fresh'];
    const fixed = () => nonces.shift() ?? 'later';
    // The input carries the first token it would get, in three places; the
    // sanitizer must notice and draw again.
    const input = '<p title="mknownt0x">mknownt0x <!-- mknownt0x --></p><math><annotation encoding="application/x-tex">y</annotation></math>';
    const out = await sanitizeHtml(input, fixed);
    expect(out).toBe(`<p title="mknownt0x">mknownt0x <!-- mknownt0x --></p>${drawing('y')}`);
  });
});

describe('drawing is bounded', () => {
  it('a formula past the TeX cap is shown as written', async () => {
    const long = 'x+'.repeat(TEX_MAX);
    const out = await sanitizeHtml(`<math><annotation encoding="application/x-tex">${long}</annotation></math>`);
    expect(out.startsWith('<code class="math-source">')).toBe(true);
    expect(out).not.toContain('<math');
  });

  it('past a thousand formulas the rest are shown as written', async () => {
    const one = '<math><annotation encoding="application/x-tex">k</annotation></math>';
    const out = await sanitizeHtml(one.repeat(1003));
    expect(out.match(/<math/g)).toHaveLength(1000);
    expect(out.match(/class="math-source"/g)).toHaveLength(3);
  });

  it('a TeX error in a foreign formula is its TeX as text', async () => {
    const out = await sanitizeHtml('<math><annotation encoding="application/x-tex">\\frac{a</annotation></math>');
    expect(out).toBe('<code class="math-source">$\\frac{a$</code>');
  });
});

describe("the renderer's output is checked", () => {
  it('a renderer that emits an unlisted attribute or element is not used', () => {
    expect(renderTex('x', false, () => '<math><mi href="x">x</mi></math>').error).toBeTruthy();
    expect(renderTex('x', false, () => '<math><mglyph src="x"/></math>').error).toBeTruthy();
    expect(renderTex('x', false, () => '<math><mi onclick="x">x</mi></math>').error).toBeTruthy();
    expect(renderTex('x', false, () => '<math><mi>x</mi></math>').error).toBeUndefined();
  });

  it('style is removed before the check, so it never decides', () => {
    expect(renderTex('x', false, () => '<math style="color:red"><mi>x</mi></math>')).toEqual({ html: '<math><mi>x</mi></math>' });
  });
});

describe('commands temml draws with menclose (v0.4-plan §23.5)', () => {
  it('an over- or underline is drawn in Core, nested ones too', () => {
    for (const tex of ['\\overline{AB}', '\\underline{a+b}', '\\overline{\\overline{x}}']) {
      const { html, error } = renderTex(tex, false);
      expect(error).toBeUndefined();
      expect(html).not.toContain('menclose');
      expect(html).toMatch(/<m(over|under) accent(under)?="true">/);
    }
  });
  it('a box is drawn plain, keeping what is in it', () => {
    for (const tex of ['\\fbox{x}', '\\boxed{y}']) {
      const { html, error } = renderTex(tex, false);
      expect(error).toBeUndefined();
      expect(html).not.toContain('menclose');
    }
  });
  it.each([['\\cancel{x}', '\\cancel'], ['\\bcancel{x}', '\\bcancel'], ['\\xcancel{x}', '\\xcancel'], ['\\sout{x}', '\\sout'], ['\\angl{n}', '\\angl'], ['\\phase{x}', '\\phase'], ['\\longdiv{x}', '\\longdiv']])('%s is refused, by name', (tex, command) => {
    expect(renderTex(tex, false).error).toContain(`${command} needs a stylesheet`);
  });
  it('an accent keeps its size: math-depth was in a style, accent says it in Core', () => {
    expect(renderTex('\\widehat{AB}', false).html).toContain('<mover accent="true">');
    expect(renderTex('\\overrightarrow{AB}', false).html).toContain('<mover accent="true">');
  });
  it('a foreign formula using a refused command is its TeX as text', async () => {
    expect(await sanitizeHtml('<math><annotation encoding="application/x-tex">\\cancel{x}</annotation></math>')).toBe('<code class="math-source">$\\cancel{x}$</code>');
  });
});

describe('the review of studio#149, R4 and the small fixes', () => {
  it('past 100,000 characters of TeX in one document, formulas are their TeX as text', async () => {
    const tex = 'x+'.repeat(1900) + 'y';
    const one = `<math><annotation encoding="application/x-tex">${tex}</annotation></math>`;
    const out = await sanitizeHtml(one.repeat(30));
    expect(out.match(/<math/g)).toHaveLength(26);
    expect(out.match(/class="math-source"/g)).toHaveLength(4);
  });
  it('encoding and display are read whatever their case', async () => {
    expect(await sanitizeHtml('<math DISPLAY="BLOCK"><annotation ENCODING="Application/X-TeX">x</annotation></math>')).toBe(drawing('x', true));
  });
});
