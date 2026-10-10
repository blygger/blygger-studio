/**
 * Reading typefaces. Every one is a stack of fonts already installed on the
 * reader's device, so choosing one downloads nothing, asks no third party for
 * anything, and keeps "no web fonts" true. The cost is that a page looks
 * slightly different from one device to the next; each stack lists close
 * equivalents across macOS, iOS, Windows, Android and Linux so the character
 * of the face survives the trip.
 *
 * The stacks are from Modern Font Stacks (modernfontstacks.com, CC0), lightly
 * trimmed. Only `--serif` changes: it carries every piece of reading text on
 * the public pages, while `--sans` stays on the apparatus (dates, bylines,
 * navigation) so the furniture keeps its shape whatever the author picks.
 *
 * `book` is the stylesheet's own stack and writes nothing.
 */
export const DEFAULT_FONT = "book";

export const FONTS: Record<string, { label: string; stack: string }> = {
  book: {
    label: "Book (default)",
    stack: '"Iowan Old Style", "Palatino Linotype", Palatino, Charter, Georgia, "Times New Roman", serif',
  },
  transitional: {
    label: "Transitional",
    stack: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
  },
  humanist: {
    label: "Humanist sans",
    stack: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
  },
  geometric: {
    label: "Geometric sans",
    stack: 'Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif',
  },
  system: {
    label: "System sans",
    stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  rounded: {
    label: "Rounded",
    stack: 'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", "Arial Rounded MT Bold", Calibri, source-sans-pro, sans-serif',
  },
  slab: {
    label: "Slab serif",
    stack: 'Rockwell, "Rockwell Nova", "Roboto Slab", "DejaVu Serif", "Sitka Small", serif',
  },
  mono: {
    label: "Monospace",
    stack: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  },
};

export function isFont(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(FONTS, id);
}

/** CSS appended to style.css for a chosen typeface; nothing for the default or an unknown id. */
export function fontCss(id: string): string {
  if (id === DEFAULT_FONT || !isFont(id)) return "";
  return `
/* typeface: ${FONTS[id].label} — system fonts only, nothing downloaded. */
:root {
  --serif: ${FONTS[id].stack};
}
`;
}
