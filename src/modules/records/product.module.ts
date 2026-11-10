import { Module } from '@nestjs/common';
import { AutomationController } from '../automation/automation.controller';
import { AutomationScheduler } from '../automation/automation.scheduler';
import { AutomationService } from '../automation/automation.service';
import { EventsController } from '../automation/events.controller';
import { WorkflowHooksController } from '../automation/workflow-hooks.controller';
import { ChannelsController } from '../channels/channels.controller';
import { DeliveryService } from '../delivery/delivery.service';
import {
  EmailOAuthCallbackController,
  EmailOAuthStartController,
} from '../delivery/email-oauth.controller';
import { UnsubscribeController } from '../delivery/unsubscribe.controller';
import { CrmController } from '../crm/crm.controller';
import { CrmService } from '../crm/crm.service';
import { InboxController } from '../inbox/inbox.controller';
import { MessagingController } from '../messaging/messaging.controller';
import { MessagingService } from '../messaging/messaging.service';
import { PlatformController } from '../platform/platform.controller';
import { PlatformService } from '../platform/platform.service';
import { RecordsController } from './records.controller';
import { RecordsService } from './records.service';

/**
 * Product modules (docs/API-CONTRACT.md). Module controllers come first so their
 * action routes match before RecordsController's catch-all standard resources.
 */
@Module({
  controllers: [
    CrmController,
    InboxController,
    ChannelsController,
    MessagingController,
    PlatformController,
    AutomationController,
    WorkflowHooksController,
    EventsController,
    EmailOAuthStartController,
    EmailOAuthCallbackController,
    UnsubscribeController,
    // Must stay last.
    RecordsController,
  ],
  providers: [
    RecordsService,
    CrmService,
    MessagingService,
    PlatformService,
    AutomationService,
    AutomationScheduler,
    DeliveryService,
  ],
  exports: [RecordsService],
})
export class ProductModule {}
