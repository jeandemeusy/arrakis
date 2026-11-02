import { Activity, ListChecks, PackageOpen, type LucideIcon } from 'lucide-react';

/** One inventory for the Settings landing page and its sidebar sub-navigation. */
export type SettingsPage = {
  href: string;
  icon: LucideIcon;
  title: string;
  text: string;
  editorOnly: boolean;
};

export const SETTINGS_PAGES: SettingsPage[] = [
  {
    href: '/settings/lists',
    icon: ListChecks,
    title: 'Lists',
    text: 'Values queries read as {{list:name}}, kept per data source or for all of them. Changing one reruns the queries that read it.',
    editorOnly: true,
  },
  {
    href: '/settings/bundles',
    icon: PackageOpen,
    title: 'Bundles',
    text: 'Import a dashboard, its charts and its queries from a bundle file or URL. Export any dashboard as one from its Share menu.',
    editorOnly: true,
  },
  {
    href: '/settings/runs',
    icon: Activity,
    title: 'Running now',
    text: 'Every query running at this moment — previews, stored runs and scheduled refreshes — with a way to cancel any of them.',
    editorOnly: true,
  },
];
