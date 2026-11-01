/**
 * The guide's sections, by anchor: the page's table of contents, the search
 * palette's "Guide" entries, and the short text a help tip shows before
 * linking to the section.
 */

export type GuideTopic = {
  id: string;
  title: string;
  /** One or two sentences: what a help tip shows. */
  summary: string;
};

export const GUIDE_TOPICS = [
  {
    id: 'start',
    title: 'How Arrakis works',
    summary:
      'Queries read a data source and store their result; charts shape a stored result; dashboards arrange charts. Reading a chart never runs a query.',
  },
  {
    id: 'queries',
    title: 'Writing and running queries',
    summary:
      'Run previews up to 10,000 rows and stores nothing (or only the selected SQL). Run and store replaces the result its charts read. Explain shows the plan.',
  },
  {
    id: 'templates',
    title: 'Placeholders',
    summary:
      'Write {{name}} for a parameter, {{> slug}} for a fragment and {{network}} for the data source a run reads. Values are bound, never pasted into the SQL.',
  },
  {
    id: 'parameters',
    title: 'Parameters',
    summary:
      'A parameter is a typed value a run takes: declare it, give it a default, and set its value for one run. It is bound as $n, so it cannot change the SQL.',
  },
  {
    id: 'fragments',
    title: 'Fragments',
    summary:
      'A fragment is SQL saved to be reused: a query stands in for a table, anything else for a value. {{> slug(arg)}} passes arguments.',
  },
  {
    id: 'results',
    title: 'Stored results and schedules',
    summary:
      'A stored result is a copy of the rows, kept until the next run. It goes stale when the query or a fragment it uses changes; a schedule reruns it.',
  },
  {
    id: 'limits',
    title: 'Run limits and cancelling',
    summary:
      'A run past its time limit is stopped; rows past the cap are left out. A running query can be cancelled from its page or from Running now.',
  },
  {
    id: 'charts',
    title: 'Charts',
    summary:
      'A chart describes how to shape a stored result: as a sentence, as steps, or as SQL over {{result}}. Its options set the axes, series and colours.',
  },
  {
    id: 'dashboards',
    title: 'Dashboards and variables',
    summary:
      'Variables are what viewers change: a range, a data source, a selected value. Charts read them through their filters; a click on a chart can set one.',
  },
  {
    id: 'lineage',
    title: 'Search and lineage',
    summary:
      'Press Cmd/Ctrl+K to find any query, chart, dashboard or table. Lineage shows what each reads and what reads it.',
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    summary:
      'Run, save, comment, search: the keys that save a trip to the mouse.',
  },
  {
    id: 'faq',
    title: 'Questions',
    summary:
      'Stale charts, empty results, slow queries and other common questions.',
  },
] as const satisfies readonly GuideTopic[];

export type GuideTopicId = (typeof GUIDE_TOPICS)[number]['id'];

export function topic(id: GuideTopicId): GuideTopic {
  return GUIDE_TOPICS.find((entry) => entry.id === id)!;
}
