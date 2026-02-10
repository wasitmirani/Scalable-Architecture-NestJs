import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({ example: false })
  success: boolean;

  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ example: '2023-01-01T00:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ example: '/api/auth/login' })
  path: string;

  @ApiProperty({ example: 'POST' })
  method: string;

  @ApiProperty({ example: 'Validation failed' })
  message: string;

  @ApiProperty({ example: 'Bad Request' })
  error: string;

  @ApiProperty({ 
    example: [
      {
        field: 'email',
        value: 'invalid-email',
        errors: ['email must be an email']
      }
    ],
    required: false 
  })
  details?: any[];

  @ApiProperty({ required: false })
  stack?: string;
}

export class ValidationErrorDto {
  @ApiProperty({ example: 'email' })
  field: string;

  @ApiProperty({ example: 'invalid-email' })
  value: any;

  @ApiProperty({ example: ['email must be an email'] })
  errors: string[];

  @ApiProperty({ required: false })
  children?: ValidationErrorDto[];
}