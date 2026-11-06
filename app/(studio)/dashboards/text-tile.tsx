'use client';

import { useState } from 'react';
import { inlineMarkdown, markdownBlocks } from '@/lib/viz/markdown';

function InlineText({ text }: { text: string }) {
  return inlineMarkdown(text).map((part, index) => {
    if (part.kind === 'strong') return <strong key={index}>{part.text}</strong>;
    if (part.kind === 'em') return <em key={index}>{part.text}</em>;
    if (part.kind === 'code') return <code key={index}>{part.text}</code>;
    if (part.kind === 'link') return <a key={index} href={part.href} target={part.href?.startsWith('/') ? undefined : '_blank'} rel={part.href?.startsWith('/') ? undefined : 'noopener noreferrer'}>{part.text}</a>;
    return part.text;
  });
}

export function TextTile({ text, style, editing, onChange, onStyle }: {
  text: string;
  style: 'plain' | 'card';
  editing: boolean;
  onChange: (text: string) => void;
  onStyle: (style: 'plain' | 'card') => void;
}) {
  const [preview, setPreview] = useState(false);
  return <div className={`dashboard-text-tile is-${style}`}>
    {editing && <div className="text-tile-controls"><label className="text-tile-style">Appearance <select value={style} onChange={(event) => onStyle(event.target.value as 'plain' | 'card')}><option value="plain">Plain</option><option value="card">Card</option></select></label><button type="button" className="studio-button" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? 'Edit text' : 'Preview'}</button></div>}
    {editing && !preview ? <>
      <textarea aria-label="Text tile content" value={text} maxLength={5000} onChange={(event) => onChange(event.target.value)} placeholder="Write text using Markdown" />
      <small>Markdown: # heading, **bold**, *italic*, - list, [link](https://…)</small>
    </> : <div className="text-tile-content">{markdownBlocks(text).map((block, index) => {
      if (block.kind === 'heading') {
        const content = <InlineText text={block.lines[0]} />;
        return block.level === 1 ? <h2 key={index}>{content}</h2> : block.level === 2 ? <h3 key={index}>{content}</h3> : <h4 key={index}>{content}</h4>;
      }
      if (block.kind === 'list') return <ul key={index}>{block.lines.map((line, at) => <li key={at}><InlineText text={line} /></li>)}</ul>;
      return <p key={index}><InlineText text={block.lines.join(' ')} /></p>;
    })}</div>}
  </div>;
}
