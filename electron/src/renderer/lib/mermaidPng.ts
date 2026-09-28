/**
 * A Mermaid diagram drawn to a PNG (Boards B6): a Visualize that made a
 * diagram lands on the Board as an image. mermaid renders the SVG (the
 * package MarkdownPreview uses, in lib/boardVisualModel's theme), then the
 * SVG goes blob → Image → canvas (the renderer's CSP allows `blob:` images)
 * and out as PNG. The pure parts (size, the sized SVG, the theme) are in
 * boardVisualModel.
 */

import { MERMAID_CONFIG, MERMAID_GROUND, rasterSize, sizedSvg, svgSize } from './boardVisualModel';

export interface MermaidPng {
  blob: Blob;
  /** The PNG's pixels. */
  w: number;
  h: number;
  /** Pixels per SVG px (the density to place it at). */
  scale: number;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The diagram couldn’t be drawn'));
    img.src = url;
  });
}

/** Draw `dsl` to a PNG, or one line saying why not. */
export async function renderMermaidPng(dsl: string): Promise<MermaidPng | { error: string }> {
  let svg: string;
  try {
    const mermaid = (await import('mermaid')).default;
    // Other views initialise mermaid their own way; set ours right before drawing.
    mermaid.initialize(MERMAID_CONFIG);
    const id = `bd-mermaid-${Math.random().toString(36).slice(2, 9)}`;
    svg = (await mermaid.render(id, dsl)).svg;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `The diagram has a mistake: ${msg.split('\n')[0]}` };
  }
  const size = svgSize(svg);
  if (!size) return { error: 'The diagram came out empty' };
  const px = rasterSize(size);
  const url = URL.createObjectURL(new Blob([sizedSvg(svg, size)], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = px.w;
    canvas.height = px.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { error: 'The diagram couldn’t be drawn' };
    ctx.fillStyle = MERMAID_GROUND;
    ctx.fillRect(0, 0, px.w, px.h);
    ctx.drawImage(img, 0, 0, px.w, px.h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return { error: 'The diagram couldn’t be drawn' };
    return { blob, w: px.w, h: px.h, scale: px.scale };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'The diagram couldn’t be drawn' };
  } finally {
    URL.revokeObjectURL(url);
  }
}
