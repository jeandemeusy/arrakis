import type { VisualizationConfig } from './config';
import type { Step } from './transform';

/** Only trace row-preserving steps; never guess the inputs of grouped or SQL charts. */
export function valueInputs(
  config: VisualizationConfig,
):
  | { supported: true; steps: Step[]; scope: 'aggregate' | 'first-row' }
  | { supported: false; reason: string } {
  if (config.sql)
    return {
      supported: false,
      reason:
        'This chart uses custom SQL, so its contributing rows cannot be determined automatically.',
    };
  const aggregate = config.steps.findIndex((step) => step.op === 'aggregate');
  const rowPreserving = new Set<Step['op']>([
    'filter',
    'range',
    'bucket',
    'compute',
    'sort',
  ]);
  const before =
    aggregate < 0 ? config.steps : config.steps.slice(0, aggregate);
  if (before.some((step) => !rowPreserving.has(step.op)))
    return {
      supported: false,
      reason:
        'This chart combines or reshapes rows before calculating the value, so its contributing rows cannot be determined reliably.',
    };
  if (
    before.some(
      (step) =>
        step.op === 'range' && step.anchor === 'now' && !step.anchorColumn,
    )
  )
    return {
      supported: false,
      reason:
        'This chart uses a moving time window, so the input rows may have changed since the displayed value was calculated.',
    };
  if (aggregate < 0)
    return { supported: true, steps: before, scope: 'first-row' };
  const step = config.steps[aggregate];
  if (step.op !== 'aggregate' || step.groupBy.length > 0)
    return {
      supported: false,
      reason:
        'This value comes from a grouped calculation, so its contributing rows cannot yet be determined reliably.',
    };
  if (
    config.steps
      .slice(aggregate + 1)
      .some((next) => !['compute', 'filter', 'sort', 'limit'].includes(next.op))
  )
    return {
      supported: false,
      reason:
        'This chart reshapes the aggregate further, so its contributing rows cannot be determined reliably.',
    };
  return { supported: true, steps: before, scope: 'aggregate' };
}
