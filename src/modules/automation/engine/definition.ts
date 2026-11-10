import type { Workflow, WorkflowDefinition } from './types';
import { defaultSettings } from './workflow';

/** The runnable part of a workflow, frozen into each published version. */
export const definitionOf = (
  w: Pick<Workflow, 'trigger' | 'steps' | 'variables' | 'allowReentry'> & {
    settings?: Workflow['settings'];
  },
): WorkflowDefinition =>
  structuredClone({
    trigger: w.trigger,
    steps: w.steps,
    variables: w.variables ?? [],
    allowReentry: w.allowReentry,
    settings: { ...defaultSettings(), ...w.settings },
  });
