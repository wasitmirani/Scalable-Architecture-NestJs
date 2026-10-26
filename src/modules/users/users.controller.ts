import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { CREATE_USER_SCHEMA } from './users.validation';
import { APP_CONSTANTS } from '../../common/constants/app.constants';
import { ValidationHelper } from '../../common/utils/validation.helper';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';

@Controller('users')
@UseFilters(HttpExceptionFilter)
@UseInterceptors(ResponseInterceptor)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll(@Query('page') page: number = 1,@Query('limit') limit: number = APP_CONSTANTS.DEFAULT_PAGE_LIMIT) {
    ValidationHelper.assertPageLimit(Number(limit));
    return this.usersService.findAll(Number(page), Number(limit));
  }

  @Get(':id')
  findOne(@Param('id') id: number | string) {
    return this.usersService.findOne(id.toString());
  }

  @Post('store')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateUserDto) {
    ValidationHelper.assert(dto, CREATE_USER_SCHEMA);
    return this.usersService.create(dto);
  }
}
