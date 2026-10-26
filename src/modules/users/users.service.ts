import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, USER_PUBLIC_COLUMNS } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { paginate, PaginationResult } from '../../common/pagination/pagination';
import { AdvancedFileLogger } from '../../services/logger.service';
import { ConflictException, NotFoundException } from '../../common/exceptions/custom.exceptions';
import { Helpers } from '../../common/utils/helpers';
import { ApiResponse, ApiResponseData } from '../../common/utils/api.response';

// Injectable service for user management
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly logger: AdvancedFileLogger,
  ) {}

  async findAll(page: number, limit: number): Promise<PaginationResult<User>> {
    const query = this.userRepo
      .createQueryBuilder('users')
      .select(USER_PUBLIC_COLUMNS.map((column) => `users.${column}`));

    return paginate(query, { page, limit, baseUrl: '/users' }, 'Users fetched successfully');
  }

  async findOne(id: string): Promise<ApiResponseData> {
    const user = await this.userRepo.findOne({
      where: { id: Number(id) },
      select: USER_PUBLIC_COLUMNS,
    });

    if (!user) {
      throw new NotFoundException('User');
    }

    return ApiResponse.success(user, 'User fetched successfully');
  }

  async create(dto: CreateUserDto): Promise<ApiResponseData> {
    await this.ensureEmailIsUnique(dto.email || '');

    const user = await this.persistUser(dto);
    this.logger.log(`User created: ${user.email} (id=${user.id})`, UsersService.name);

    return ApiResponse.created(this.toPublicUser(user), 'User created successfully');
  }

  private async ensureEmailIsUnique(email: string): Promise<void> {
    const existing = await this.userRepo.findOne({ where: { email } });

    if (existing) {
      throw new ConflictException('User with this email already exists');
    }
  }

  // persist user to database with validation
  private async persistUser(dto: CreateUserDto): Promise<User> {
    if (!dto.name || !dto.email || !dto.password) {
      throw new BadRequestException('Name, email and password are required');
    }
    const user = this.userRepo.create({
      name: dto.name,
      email: dto.email,
      password: dto.password,
      userName: dto.userName || Helpers.generateUsernameFromEmail(dto.email || ''),
      slug: dto.slug || Helpers.generateSlug(dto.name || ''),
      firstName: dto.firstName,
      lastName: dto.lastName,
      thumbnail: dto.thumbnail || 'default.png',
    });

    return this.userRepo.save(user);
  }

  private toPublicUser(user: User): Partial<User> {
    const { password: _password, rememberToken: _token, ...publicUser } = user;
    return publicUser;
  }
}
