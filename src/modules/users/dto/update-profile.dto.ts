import { IsString, Length } from 'class-validator';

export class UpdateProfileDto {
  @IsString()
  @Length(2, 120)
  name: string;
}
