'use client';

import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';

export type PersonalItem = { kind: 'dashboard' | 'query'; slug: string };
const key = (name: string) => `arrakis.${name}`;
export function readItems(name: string): PersonalItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(name)) ?? '[]');
    return Array.isArray(value)
      ? value.filter(
          (item) =>
            item &&
            (item.kind === 'dashboard' || item.kind === 'query') &&
            typeof item.slug === 'string',
        )
      : [];
  } catch {
    return [];
  }
}
function writeItems(name: string, items: PersonalItem[]) {
  try {
    localStorage.setItem(key(name), JSON.stringify(items));
    window.dispatchEvent(new Event('arrakis-personal'));
  } catch {
    /* Storage can be disabled. */
  }
}
const same = (a: PersonalItem, b: PersonalItem) =>
  a.kind === b.kind && a.slug === b.slug;
export function usePersonal(name: string) {
  const [items, setItems] = useState<PersonalItem[]>([]);
  useEffect(() => {
    const update = () => setItems(readItems(name));
    update();
    window.addEventListener('arrakis-personal', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('arrakis-personal', update);
      window.removeEventListener('storage', update);
    };
  }, [name]);
  return items;
}
export function Favorite({ item }: { item: PersonalItem }) {
  const favorites = usePersonal('favorites');
  const active = favorites.some((entry) => same(entry, item));
  return (
    <button
      type="button"
      className="studio-button favorite-button"
      aria-label={`${active ? 'Remove' : 'Add'} ${item.slug} ${active ? 'from' : 'to'} favorites`}
      title={active ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={active}
      onClick={() =>
        writeItems(
          'favorites',
          active
            ? favorites.filter((entry) => !same(entry, item))
            : [...favorites, item],
        )
      }
    >
      <Star
        size={15}
        fill={active ? 'currentColor' : 'none'}
        aria-hidden="true"
      />
    </button>
  );
}
export function Visit({ item }: { item: PersonalItem }) {
  const { kind, slug } = item;
  useEffect(() => {
    const item = { kind, slug };
    writeItems(
      'recent',
      [
        item,
        ...readItems('recent').filter((entry) => !same(entry, item)),
      ].slice(0, 20),
    );
  }, [kind, slug]);
  return null;
}
