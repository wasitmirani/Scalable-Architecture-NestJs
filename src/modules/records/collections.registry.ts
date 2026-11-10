import { workflowsCollection } from '../automation/automation.collections';
import {
  callsCollection,
  channelAccountsCollection,
  emailSendersCollection,
  ivrMenusCollection,
  livechatWidgetsCollection,
  phoneNumbersCollection,
  senderDomainsCollection,
} from '../channels/channels.collections';
import {
  attributesCollection,
  contactsCollection,
  importsCollection,
  listsCollection,
  segmentsCollection,
} from '../crm/crm.collections';
import {
  companiesCollection,
  dealsCollection,
  pipelinesCollection,
  tasksCollection,
} from '../crm/sales.collections';
import {
  cannedRepliesCollection,
  conversationsCollection,
} from '../inbox/inbox.collections';
import {
  campaignsCollection,
  messagesCollection,
  templatesCollection,
} from '../messaging/messaging.collections';
import {
  formsCollection,
  integrationsCollection,
  invoicesCollection,
  notificationsCollection,
  webhookEndpointsCollection,
} from '../platform/platform.collections';
import type { CollectionDef } from './collection.types';

/** Every standard resource in docs/API-CONTRACT.md. */
export const COLLECTIONS: CollectionDef[] = [
  contactsCollection,
  importsCollection,
  listsCollection,
  segmentsCollection,
  attributesCollection,
  companiesCollection,
  pipelinesCollection,
  dealsCollection,
  tasksCollection,
  conversationsCollection,
  cannedRepliesCollection,
  campaignsCollection,
  templatesCollection,
  messagesCollection,
  workflowsCollection,
  channelAccountsCollection,
  senderDomainsCollection,
  emailSendersCollection,
  phoneNumbersCollection,
  livechatWidgetsCollection,
  callsCollection,
  ivrMenusCollection,
  formsCollection,
  webhookEndpointsCollection,
  invoicesCollection,
  notificationsCollection,
  integrationsCollection,
];
