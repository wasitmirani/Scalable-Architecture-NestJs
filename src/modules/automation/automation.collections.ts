import type { CollectionDef } from '../records/collection.types';
import { fieldError } from '../records/record-store';
import { upgrade } from './automation.service';

export const workflowsCollection: CollectionDef = {
  path: 'workflows',
  read: 'automations.read',
  write: 'automations.manage',
  searchFields: ['name', 'description'],
  defaultSort: 'updatedAt',
  // Going live and versions only happen through publish/pause/resume (automations.publish).
  serverFields: ['status', 'version', 'versions', 'stats'],
  /** Older rows (yes/no branches, no variables) are upgraded on read, as in the UI. */
  decorate: (_ctx, rows) => rows.map(upgrade),
  beforeCreate: (_ctx, input) => {
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw fieldError(422, 'REQUIRED', 'name', 'Name is required');
    }
    return {
      description: '',
      steps: [],
      variables: [],
      allowReentry: false,
      settings: {},
      ...input,
      status: 'draft',
      version: 0,
      versions: [],
      stats: { enrolled: 0, active: 0, completed: 0, goalReached: 0 },
    };
  },
  beforeDelete: async (ctx, workflow) => {
    await ctx.store.removeWhere('executions', { workflowId: workflow.id });
  },
};
