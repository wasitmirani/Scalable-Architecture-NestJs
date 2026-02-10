import { Controller, Get,Query,Res,Param  } from '@nestjs/common';
import { UsersService } from './users.service';
import { APP_CONSTANTS } from 'src/common/constants/app.constants';



@Controller('users')
export class UsersController {
  constructor(private readonly userService: UsersService) {}

  @Get()
  async users(@Query('page') page = 1,@Query('limit') limit = APP_CONSTANTS.DEFAULT_PAGE_LIMIT, @Res() res) {

    if(limit > APP_CONSTANTS.MAX_PAGE_LIMIT) {
      return  res.status(400).json({ error: 'Limit exceeded. Maximum limit is 100.' });
    }
    return res.json(await this.userService.getUsers(Number(page), Number(limit)));
  }

  @Get(':id')
  async getUser(@Param('id') id: string, @Res() res) {

      console.log('Fetching user with id:', id);
      const user = await this.userService.getUserById(id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.json(user);
  }

}