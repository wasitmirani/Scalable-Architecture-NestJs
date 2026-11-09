import { Controller, Get, VERSION_NEUTRAL, Version } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';

@ApiTags('Health')
@Public()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** Liveness and database readiness: GET /api/health */
  @Get('health')
  @Version(VERSION_NEUTRAL)
  health() {
    return this.appService.health();
  }
}
