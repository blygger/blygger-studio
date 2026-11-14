// Fixed hostile corpus, not a claim of exhaustive HTML grammar coverage. Both
// receiving drivers use these bytes; neither derives expectations from sanitizeHtml.
const effect = "document.documentElement.setAttribute('data-import-script','yes');void(0)";
export const importedHtmlAttacks = [
  { id: 'literal', html: `<p><a href="javascript:${effect}">attack literal</a></p>`, click: 'attack literal' },
  { id: 'tab', html: `<p><a href="java&#9;script:${effect}">attack tab</a></p>`, click: 'attack tab' },
  { id: 'newline', html: `<p><a href="java&#10;script:${effect}">attack newline</a></p>`, click: 'attack newline' },
  { id: 'return', html: `<p><a href="java&#13;script:${effect}">attack return</a></p>`, click: 'attack return' },
  { id: 'svg-link', html: `<svg xmlns="http://www.w3.org/2000/svg"><a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="javascript:${effect}"><text x="0" y="20">attack svg-link</text></a></svg>`, click: 'attack svg-link' },
  { id: 'svg-event', html: `<svg onload="${effect}"><text x="0" y="20">attack svg-event</text></svg>` },
  { id: 'mathml', html: `<math><mtext><img src="/missing-security-image" onerror="${effect}"></mtext></math>` },
  { id: 'mutation', html: `<math><mtext><table><mglyph><style><!--</style><img title="--><img src=/missing-security-image onerror=${effect}>">` },
  // #105: a formula with a TeX annotation is redrawn, so these reach the redraw
  // path rather than the drop. Nothing but the annotation's text may survive.
  { id: 'math-mtext', html: `<math><semantics><mtext><img src="/missing-security-image" onerror="${effect}"></mtext><annotation encoding="application/x-tex">x^2</annotation></semantics></math>` },
  { id: 'math-annotation-xml', html: `<math><semantics><mi>x</mi><annotation-xml encoding="text/html"><img src="/missing-security-image" onerror="${effect}"></annotation-xml><annotation encoding="application/x-tex">x^2</annotation></semantics></math>` },
  { id: 'math-link', html: `<math><semantics><mi xlink:href="javascript:${effect}" href="javascript:${effect}">attack math-link</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math>`, click: 'attack math-link' },
  { id: 'math-mutation', html: `<math><annotation encoding="application/x-tex">x^2</annotation><mtext><table><mglyph><style><!--</style><img title="--><img src=/missing-security-image onerror=${effect}>">` },
  { id: 'math-tex-markup', html: `<math><semantics><mi>x</mi><annotation encoding="application/x-tex">&lt;img src=/missing-security-image onerror=${effect}&gt;</annotation></semantics></math>` },
  { id: 'math-nested', html: `<math><semantics><mrow><math><mtext><img src="/missing-security-image" onerror="${effect}"></mtext></math></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math>` },
  { id: 'math-comment', html: `<math><semantics><mtext><!--<img src=/missing-security-image onerror=${effect}>--></mtext><annotation encoding="application/x-tex">x^2</annotation></semantics></math>` },
  { id: 'srcdoc', html: `<iframe srcdoc="&lt;script&gt;${effect}&lt;/script&gt;"></iframe>` },
  { id: 'data-link', html: `<p><a href="data:text/html,&lt;script&gt;${effect}&lt;/script&gt;">attack data-link</a></p>`, click: 'attack data-link' },
] as const;
