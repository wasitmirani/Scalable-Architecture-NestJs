import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AuthModule } from '../auth/auth.module';
import { RealtimeService } from '../realtime/realtime.service';
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
import { ChannelWebhooksController } from '../delivery/channel-webhooks.controller';
import { InboundService } from '../delivery/inbound.service';
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
  // Realtime verifies access tokens and workspace membership like the HTTP guard.
  imports: [AuthModule, AccessModule],
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
    ChannelWebhooksController,
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
    InboundService,
    RealtimeService,
  ],
  exports: [RecordsService],
})
export class ProductModule {}
